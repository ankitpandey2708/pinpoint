import { parse } from '@babel/parser';
import _traverse, { type NodePath } from '@babel/traverse';
import type {
  JSXOpeningElement,
  JSXIdentifier,
  Node as BabelNode,
} from '@babel/types';
import MagicString from 'magic-string';
import { sourceId } from '../lib/ids';
import type { SourceMapping } from '../domain/types';
import type { InstrumentationResult } from './types';

// @babel/traverse ships a CJS default export that interop can wrap; unwrap it.
const traverse = (( _traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

function isLowercaseHostTag(node: JSXOpeningElement): string | undefined {
  if (node.name.type !== 'JSXIdentifier') return undefined; // skip member/namespaced
  const name = (node.name as JSXIdentifier).name;
  // DOM host tags start with a lowercase letter; components are capitalized.
  if (!/^[a-z]/.test(name)) return undefined;
  return name;
}

/** Walk ancestors to find the nearest component/function/class name. */
function nearestComponentName(path: NodePath<JSXOpeningElement>): string | undefined {
  let current: NodePath<BabelNode> | null = path.parentPath;
  while (current) {
    const node = current.node;
    if (node.type === 'FunctionDeclaration' && node.id) return node.id.name;
    if (node.type === 'ClassDeclaration' && node.id) return node.id.name;
    if (
      (node.type === 'ArrowFunctionExpression' ||
        node.type === 'FunctionExpression') &&
      current.parentPath?.node.type === 'VariableDeclarator'
    ) {
      const declarator = current.parentPath.node;
      if (declarator.type === 'VariableDeclarator' && declarator.id.type === 'Identifier') {
        return declarator.id.name;
      }
    }
    current = current.parentPath;
  }
  return undefined;
}

/**
 * Instrument JSX/TSX by inserting a stable `data-pinpoint-id` on every
 * lowercase DOM host element. Custom components, fragments, and
 * member/namespaced elements are left untouched. Edits are byte-level via
 * MagicString so surrounding source is never reformatted.
 */
export function instrumentJsx(source: string, relativeFile: string): InstrumentationResult {
  const ast = parse(source, {
    sourceType: 'module',
    plugins: ['jsx', 'typescript'],
  });

  const s = new MagicString(source);
  const mappings: SourceMapping[] = [];

  traverse(ast, {
    JSXOpeningElement(path) {
      const tag = isLowercaseHostTag(path.node);
      if (!tag) return;
      const nameNode = path.node.name as JSXIdentifier;
      if (nameNode.end == null || !path.node.loc) return;
      const line = path.node.loc.start.line;
      const column = path.node.loc.start.column;
      const id = sourceId(relativeFile, line, column, tag);
      s.appendLeft(nameNode.end, ` data-pinpoint-id="${id}"`);
      mappings.push({
        elementId: id,
        sourceFile: relativeFile,
        component: nearestComponentName(path),
        line,
        column,
        tag,
        confidence: 'direct',
      });
    },
  });

  return { content: s.toString(), mappings };
}
