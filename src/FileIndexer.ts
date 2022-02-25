import * as ts from 'typescript'

import { Counter } from './Counter'
import {
  metaDescriptor,
  methodDescriptor,
  packageDescriptor,
  parameterDescriptor,
  termDescriptor,
  typeDescriptor,
  typeParameterDescriptor,
} from './Descriptor'
import { Input } from './Input'
import * as lsif from './lsif'
import { LsifSymbol } from './LsifSymbol'
import { lsiftyped } from './main'
import { Packages } from './Packages'
import { Range } from './Range'

type Descriptor = lsif.lib.codeintel.lsiftyped.Descriptor

export class FileIndexer {
  private localCounter = new Counter()
  private propertyCounters: Map<string, Counter> = new Map()
  private localSymbolTable: Map<ts.Node, LsifSymbol> = new Map()
  constructor(
    public readonly checker: ts.TypeChecker,
    public readonly input: Input,
    public readonly document: lsif.lib.codeintel.lsiftyped.Document,
    public readonly globalSymbolTable: Map<ts.Node, LsifSymbol>,
    public readonly packages: Packages,
    public readonly sourceFile: ts.SourceFile
  ) {}
  public index(): void {
    this.visit(this.sourceFile)
  }
  private visit(node: ts.Node): void {
    if (ts.isIdentifier(node)) {
      const sym = this.checker.getSymbolAtLocation(node)
      if (sym) {
        this.visitIdentifier(node, sym)
      }
    }
    ts.forEachChild(node, node => this.visit(node))
  }

  private visitIdentifier(identifier: ts.Identifier, sym: ts.Symbol): void {
    const range = Range.fromNode(identifier).toLsif()
    let role = 0
    const isDefinition = this.declarationName(identifier.parent) === identifier
    if (isDefinition) {
      role |= lsiftyped.SymbolRole.Definition
    }
    for (const declaration of sym?.declarations || []) {
      const lsifSymbol = this.lsifSymbol(declaration)
      if (lsifSymbol.isEmpty()) {
        // Skip empty symbols
        continue
      }
      this.document.occurrences.push(
        new lsif.lib.codeintel.lsiftyped.Occurrence({
          range,
          symbol: lsifSymbol.value,
          symbol_roles: role,
        })
      )
      if (isDefinition) {
        this.addSymbolInformation(identifier, sym, lsifSymbol)
        this.handleShorthandPropertyDefinition(declaration, range)
      }
    }
  }

  /**
   * Handles the special-case around shorthand property syntax so that we emit two occurrences instead of only one.
   * Shorthand properties need two symbols because they both define a symbol and reference a symbol. For example:
   * ```
   * const a = 42
   * const b = {a}
   * //         ^ both references the local const `a` and defines a new property
   * const c = b.a
   * //          ^ reference to the property `a`, not the local const
   * ```
   */

  private handleShorthandPropertyDefinition(
    declaration: ts.Node,
    range: number[]
  ): void {
    if (declaration.kind === ts.SyntaxKind.ShorthandPropertyAssignment) {
      const valueSymbol =
        this.checker.getShorthandAssignmentValueSymbol(declaration)
      if (!valueSymbol) {
        return
      }
      for (const symbol of valueSymbol?.declarations || []) {
        const lsifSymbol = this.lsifSymbol(symbol)
        if (lsifSymbol.isEmpty()) {
          continue
        }
        this.document.occurrences.push(
          new lsif.lib.codeintel.lsiftyped.Occurrence({
            range,
            symbol: lsifSymbol.value,
          })
        )
      }
    }
  }

  private addSymbolInformation(
    node: ts.Node,
    sym: ts.Symbol,
    symbol: LsifSymbol
  ): void {
    this.document.symbols.push(
      new lsiftyped.SymbolInformation({
        symbol: symbol.value,
        documentation: [
          '```ts\n' +
            this.checker.typeToString(this.checker.getTypeAtLocation(node)) +
            '\n```',
          ts.displayPartsToString(sym.getDocumentationComment(this.checker)),
        ],
      })
    )
  }

  private declarationName(node: ts.Node): ts.Node | undefined {
    if (
      ts.isEnumDeclaration(node) ||
      ts.isVariableDeclaration(node) ||
      ts.isPropertyDeclaration(node) ||
      ts.isMethodSignature(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isPropertySignature(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isModuleDeclaration(node) ||
      ts.isPropertyAssignment(node) ||
      ts.isShorthandPropertyAssignment(node) ||
      ts.isParameter(node) ||
      ts.isTypeParameterDeclaration(node) ||
      ts.isInterfaceDeclaration(node)
    ) {
      return node.name
    }
    return undefined
  }

  private lsifSymbol(node: ts.Node): LsifSymbol {
    const fromCache: LsifSymbol | undefined =
      this.globalSymbolTable.get(node) || this.localSymbolTable.get(node)
    if (fromCache) {
      return fromCache
    }
    if (ts.isBlock(node)) {
      return LsifSymbol.empty()
    }
    if (ts.isSourceFile(node)) {
      const package_ = this.packages.symbol(node.fileName)
      if (!package_) {
        return this.cached(node, LsifSymbol.empty())
      }
      return this.cached(node, package_)
    }
    if (
      ts.isPropertyAssignment(node) ||
      ts.isShorthandPropertyAssignment(node)
    ) {
      const name = node.name.getText()
      let counter = this.propertyCounters.get(name)
      if (!counter) {
        counter = new Counter()
        this.propertyCounters.set(name, counter)
      }
      return this.cached(
        node,
        LsifSymbol.global(
          this.lsifSymbol(node.getSourceFile()),
          metaDescriptor(`${node.name.getText()}${counter.next()}`)
        )
      )
    }
    const owner = this.lsifSymbol(node.parent)
    if (owner.isEmpty() || owner.isLocal()) {
      return this.newLocalSymbol(node)
    }

    if (isAnonymousContainerOfSymbols(node)) {
      return this.cached(node, this.lsifSymbol(node.parent))
    }
    if (ts.isImportSpecifier(node)) {
      const tpe = this.checker.getTypeAtLocation(node)
      for (const declaration of tpe.symbol?.declarations || []) {
        return this.lsifSymbol(declaration)
      }
    }

    const desc = this.descriptor(node)
    if (desc) {
      return this.cached(node, LsifSymbol.global(owner, desc))
    }

    // Fallback case: generate a local symbol. It's not a bug when this case
    // happens. For example, we hit this case for block `{}` that are local
    // symbols, which are direct children of global symbols (toplevel
    // functions).
    return this.newLocalSymbol(node)
  }

  private newLocalSymbol(node: ts.Node): LsifSymbol {
    const symbol = LsifSymbol.local(this.localCounter.next())
    this.localSymbolTable.set(node, symbol)
    return symbol
  }
  private cached(node: ts.Node, symbol: LsifSymbol): LsifSymbol {
    this.globalSymbolTable.set(node, symbol)
    return symbol
  }
  private descriptor(node: ts.Node): Descriptor | undefined {
    if (ts.isInterfaceDeclaration(node) || ts.isEnumDeclaration(node)) {
      return typeDescriptor(node.name.getText())
    }
    if (ts.isClassLike(node)) {
      const name = node.name?.getText()
      if (name) {
        return typeDescriptor(name)
      }
    }
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isMethodSignature(node) ||
      ts.isMethodDeclaration(node)
    ) {
      const name = node.name?.getText()
      if (name) {
        return methodDescriptor(name)
      }
    }
    if (ts.isConstructorDeclaration(node)) {
      return methodDescriptor('<constructor>')
    }
    if (
      ts.isPropertyDeclaration(node) ||
      ts.isPropertySignature(node) ||
      ts.isEnumMember(node) ||
      ts.isVariableDeclaration(node)
    ) {
      return termDescriptor(node.name.getText())
    }
    if (ts.isModuleDeclaration(node)) {
      return packageDescriptor(node.name.getText())
    }
    if (ts.isParameter(node)) {
      return parameterDescriptor(node.name.getText())
    }
    if (ts.isTypeParameterDeclaration(node)) {
      return typeParameterDescriptor(node.name.getText())
    }
    return undefined
  }
}

function isAnonymousContainerOfSymbols(node: ts.Node): boolean {
  return (
    ts.isModuleBlock(node) ||
    ts.isImportDeclaration(node) ||
    ts.isImportClause(node) ||
    ts.isNamedImports(node) ||
    ts.isVariableStatement(node) ||
    ts.isVariableDeclarationList(node)
  )
}
