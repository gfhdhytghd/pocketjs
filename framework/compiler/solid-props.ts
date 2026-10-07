import type {PluginObj} from '@babel/core';

/** Keep prop reads pure. Solid otherwise constructs a conditional memo inside
 * each component getter, which imperative readers subscribe without an owner.
 * Its existing zero-argument IIFE lowering emits a plain getter instead. Leave
 * child conditional memoization intact so a truthy condition changing value
 * does not remount its branch. No IIFE remains in the emitted getter. */
export function solidConditionalProps(api:{types:typeof import('@babel/types')}):PluginObj {
 const t=api.types;
 return {name:'pocket-solid-conditional-props',visitor:{Program(program){program.traverse({JSXElement(path){
  const opening=path.node.openingElement,name=opening.name;
  if(!t.isJSXMemberExpression(name)&&!(t.isJSXIdentifier(name)&&!/^[a-z]/.test(name.name)))return;
  for(const attribute of opening.attributes){
   if(!t.isJSXAttribute(attribute)||!t.isJSXExpressionContainer(attribute.value))continue;
   const expression=attribute.value.expression;
   if(t.isLogicalExpression(expression)||t.isConditionalExpression(expression))
    attribute.value.expression=t.callExpression(t.arrowFunctionExpression([],expression),[]);
  }
 }});}}};
}
