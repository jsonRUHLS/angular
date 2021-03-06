/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {AST, Attribute, BoundDirectivePropertyAst, BoundEventAst, CompileTypeSummary, CssSelector, DirectiveAst, ElementAst, SelectorMatcher, TemplateAstPath, findNode, tokenReference} from '@angular/compiler';
import {getExpressionScope} from '@angular/compiler-cli/src/language_services';

import {AstResult} from './common';
import {getExpressionSymbol} from './expressions';
import {Definition, DirectiveKind, Span, Symbol} from './types';
import {diagnosticInfoFromTemplateInfo, findTemplateAstAt, inSpan, offsetSpan, spanOf} from './utils';

export interface SymbolInfo {
  symbol: Symbol;
  span: Span;
  compileTypeSummary: CompileTypeSummary|undefined;
}

/**
 * Traverse the template AST and locate the Symbol at the specified `position`.
 * @param info Ast and Template Source
 * @param position location to look for
 */
export function locateSymbol(info: AstResult, position: number): SymbolInfo|undefined {
  const templatePosition = position - info.template.span.start;
  const path = findTemplateAstAt(info.templateAst, templatePosition);
  let compileTypeSummary: CompileTypeSummary|undefined = undefined;
  if (path.tail) {
    let symbol: Symbol|undefined = undefined;
    let span: Span|undefined = undefined;
    const attributeValueSymbol = (ast: AST, inEvent: boolean = false): boolean => {
      const attribute = findAttribute(info, position);
      if (attribute) {
        if (inSpan(templatePosition, spanOf(attribute.valueSpan))) {
          const dinfo = diagnosticInfoFromTemplateInfo(info);
          const scope = getExpressionScope(dinfo, path, inEvent);
          if (attribute.valueSpan) {
            const expressionOffset = attribute.valueSpan.start.offset;
            const result = getExpressionSymbol(
                scope, ast, templatePosition - expressionOffset, info.template.query);
            if (result) {
              symbol = result.symbol;
              span = offsetSpan(result.span, expressionOffset);
            }
          }
          return true;
        }
      }
      return false;
    };
    path.tail.visit(
        {
          visitNgContent(ast) {},
          visitEmbeddedTemplate(ast) {},
          visitElement(ast) {
            const component = ast.directives.find(d => d.directive.isComponent);
            if (component) {
              compileTypeSummary = component.directive;
              symbol = info.template.query.getTypeSymbol(compileTypeSummary.type.reference);
              symbol = symbol && new OverrideKindSymbol(symbol, DirectiveKind.COMPONENT);
              span = spanOf(ast);
            } else {
              // Find a directive that matches the element name
              const directive = ast.directives.find(
                  d => d.directive.selector != null && d.directive.selector.indexOf(ast.name) >= 0);
              if (directive) {
                compileTypeSummary = directive.directive;
                symbol = info.template.query.getTypeSymbol(compileTypeSummary.type.reference);
                symbol = symbol && new OverrideKindSymbol(symbol, DirectiveKind.DIRECTIVE);
                span = spanOf(ast);
              }
            }
          },
          visitReference(ast) {
            symbol = ast.value && info.template.query.getTypeSymbol(tokenReference(ast.value));
            span = spanOf(ast);
          },
          visitVariable(ast) {},
          visitEvent(ast) {
            if (!attributeValueSymbol(ast.handler, /* inEvent */ true)) {
              symbol = findOutputBinding(info, path, ast);
              symbol = symbol && new OverrideKindSymbol(symbol, DirectiveKind.EVENT);
              span = spanOf(ast);
            }
          },
          visitElementProperty(ast) { attributeValueSymbol(ast.value); },
          visitAttr(ast) {
            const element = path.head;
            if (!element || !(element instanceof ElementAst)) return;
            // Create a mapping of all directives applied to the element from their selectors.
            const matcher = new SelectorMatcher<DirectiveAst>();
            for (const dir of element.directives) {
              if (!dir.directive.selector) continue;
              matcher.addSelectables(CssSelector.parse(dir.directive.selector), dir);
            }

            // See if this attribute matches the selector of any directive on the element.
            // TODO(ayazhafiz): Consider caching selector matches (at the expense of potentially
            // very high memory usage).
            const attributeSelector = `[${ast.name}=${ast.value}]`;
            const parsedAttribute = CssSelector.parse(attributeSelector);
            if (!parsedAttribute.length) return;
            matcher.match(parsedAttribute[0], (_, directive) => {
              symbol = info.template.query.getTypeSymbol(directive.directive.type.reference);
              symbol = symbol && new OverrideKindSymbol(symbol, DirectiveKind.DIRECTIVE);
              span = spanOf(ast);
            });
          },
          visitBoundText(ast) {
            const expressionPosition = templatePosition - ast.sourceSpan.start.offset;
            if (inSpan(expressionPosition, ast.value.span)) {
              const dinfo = diagnosticInfoFromTemplateInfo(info);
              const scope = getExpressionScope(dinfo, path, /* includeEvent */ false);
              const result =
                  getExpressionSymbol(scope, ast.value, expressionPosition, info.template.query);
              if (result) {
                symbol = result.symbol;
                span = offsetSpan(result.span, ast.sourceSpan.start.offset);
              }
            }
          },
          visitText(ast) {},
          visitDirective(ast) {
            compileTypeSummary = ast.directive;
            symbol = info.template.query.getTypeSymbol(compileTypeSummary.type.reference);
            span = spanOf(ast);
          },
          visitDirectiveProperty(ast) {
            if (!attributeValueSymbol(ast.value)) {
              symbol = findInputBinding(info, path, ast);
              span = spanOf(ast);
            }
          }
        },
        null);
    if (symbol && span) {
      return {symbol, span: offsetSpan(span, info.template.span.start), compileTypeSummary};
    }
  }
}

function findAttribute(info: AstResult, position: number): Attribute|undefined {
  const templatePosition = position - info.template.span.start;
  const path = findNode(info.htmlAst, templatePosition);
  return path.first(Attribute);
}

function findInputBinding(
    info: AstResult, path: TemplateAstPath, binding: BoundDirectivePropertyAst): Symbol|undefined {
  const element = path.first(ElementAst);
  if (element) {
    for (const directive of element.directives) {
      const invertedInput = invertMap(directive.directive.inputs);
      const fieldName = invertedInput[binding.templateName];
      if (fieldName) {
        const classSymbol = info.template.query.getTypeSymbol(directive.directive.type.reference);
        if (classSymbol) {
          return classSymbol.members().get(fieldName);
        }
      }
    }
  }
}

function findOutputBinding(info: AstResult, path: TemplateAstPath, binding: BoundEventAst): Symbol|
    undefined {
  const element = path.first(ElementAst);
  if (element) {
    for (const directive of element.directives) {
      const invertedOutputs = invertMap(directive.directive.outputs);
      const fieldName = invertedOutputs[binding.name];
      if (fieldName) {
        const classSymbol = info.template.query.getTypeSymbol(directive.directive.type.reference);
        if (classSymbol) {
          return classSymbol.members().get(fieldName);
        }
      }
    }
  }
}

function invertMap(obj: {[name: string]: string}): {[name: string]: string} {
  const result: {[name: string]: string} = {};
  for (const name of Object.keys(obj)) {
    const v = obj[name];
    result[v] = name;
  }
  return result;
}

/**
 * Wrap a symbol and change its kind to component.
 */
class OverrideKindSymbol implements Symbol {
  public readonly kind: DirectiveKind;
  constructor(private sym: Symbol, kindOverride: DirectiveKind) { this.kind = kindOverride; }

  get name(): string { return this.sym.name; }

  get language(): string { return this.sym.language; }

  get type(): Symbol|undefined { return this.sym.type; }

  get container(): Symbol|undefined { return this.sym.container; }

  get public(): boolean { return this.sym.public; }

  get callable(): boolean { return this.sym.callable; }

  get nullable(): boolean { return this.sym.nullable; }

  get definition(): Definition { return this.sym.definition; }

  members() { return this.sym.members(); }

  signatures() { return this.sym.signatures(); }

  selectSignature(types: Symbol[]) { return this.sym.selectSignature(types); }

  indexed(argument: Symbol) { return this.sym.indexed(argument); }
}
