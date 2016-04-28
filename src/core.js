/**
 * Copyright 2015 The Incremental DOM Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  createElement,
  createText
} from './nodes';
import { getData } from './node_data';
import { Context } from './context';
import {
  assertInPatch,
  assertKeyedTagMatches,
  assertNoUnclosedTags,
  assertNotInAttributes,
  assertVirtualAttributesClosed,
  assertNoChildrenDeclaredYet,
  assertPatchElementNoExtras,
  setInAttributes,
  setInSkip
} from './assertions';


/** @type {?Context} */
let context = null;

/** @type {?Node} */
let currentNode = null;

/** @type {?Node} */
let currentParent = null;

/** @type {?Document} */
let doc = null;


/**
 * Returns a patcher function that sets up and restores a patch context,
 * running the run function with the provided data.
 * @param {function((!Element|!DocumentFragment),!function(T),T=): ?Node} run
 * @return {function((!Element|!DocumentFragment),!function(T),T=): ?Node}
 * @template T
 */
const patchFactory = function(run) {
  /**
   * TODO(moz): These annotations won't be necessary once we switch to Closure
   * Compiler's new type inference. Remove these once the switch is done.
   *
   * @param {(!Element|!DocumentFragment)} node
   * @param {!function(T)} fn
   * @param {T=} data
   * @return {?Node} node
   * @template T
   */
  const f = function(node, fn, data) {
    const prevContext = context;
    const prevDoc = doc;
    const prevCurrentNode = currentNode;
    const prevCurrentParent = currentParent;
    let previousInAttributes = false;
    let previousInSkip = false;

    context = new Context();
    doc = node.ownerDocument;
    currentParent = node.parentNode;

    if (process.env.NODE_ENV !== 'production') {
      previousInAttributes = setInAttributes(false);
      previousInSkip = setInSkip(false);
    }

    const retVal = run(node, fn, data);

    if (process.env.NODE_ENV !== 'production') {
      assertVirtualAttributesClosed();
      setInAttributes(previousInAttributes);
      setInSkip(previousInSkip);
    }

    context.notifyChanges();

    context = prevContext;
    doc = prevDoc;
    currentNode = prevCurrentNode;
    currentParent = prevCurrentParent;

    return retVal;
  };
  return f;
};


/**
 * Patches the document starting at node with the provided function. This
 * function may be called during an existing patch operation.
 * @param {!Element|!DocumentFragment} node The Element or Document
 *     to patch.
 * @param {!function(T)} fn A function containing elementOpen/elementClose/etc.
 *     calls that describe the DOM.
 * @param {T=} data An argument passed to fn to represent DOM state.
 * @return {!Node} The patched node.
 * @template T
 */
const patchInner = patchFactory(function(node, fn, data) {
  currentNode = node;

  enterNode();
  fn(data);
  exitNode();

  if (process.env.NODE_ENV !== 'production') {
    assertNoUnclosedTags(currentNode, node);
  }

  return node;
});


/**
 * Patches an Element with the the provided function. Exactly one top level
 * element call should be made corresponding to `node`.
 * @param {!Element} node The Element where the patch should start.
 * @param {!function(T)} fn A function containing elementOpen/elementClose/etc.
 *     calls that describe the DOM. This should have at most one top level
 *     element call.
 * @param {T=} data An argument passed to fn to represent DOM state.
 * @return {?Node} The node if it was updated, its replacedment or null if it
 *     was removed.
 * @template T
 */
const patchOuter = patchFactory(function(node, fn, data) {
  let startNode = /** @type {!Element} */({ nextSibling: node });
  let expectedNextNode = null;
  let expectedPrevNode = null;

  if (process.env.NODE_ENV !== 'production') {
    expectedNextNode = node.nextSibling;
    expectedPrevNode = node.previousSibling;
  }

  currentNode = startNode;
  fn(data);

  if (process.env.NODE_ENV !== 'production') {
    assertPatchElementNoExtras(startNode, currentNode, expectedNextNode,
        expectedPrevNode);
  }

  if (node !== currentNode) {
    removeChild(currentParent, node, getData(currentParent).keyMap);
  }

  return (startNode === currentNode) ? null : currentNode;
});


/**
 * Checks whether or not the current node matches the specified nodeName and
 * key.
 *
 * @param {?string} nodeName The nodeName for this node.
 * @param {?string=} key An optional key that identifies a node.
 * @return {boolean} True if the node matches, false otherwise.
 */
const matches = function(nodeName, key) {
  const data = getData(currentNode);

  // Key check is done using double equals as we want to treat a null key the
  // same as undefined. This should be okay as the only values allowed are
  // strings, null and undefined so the == semantics are not too weird.
  return nodeName === data.nodeName && key == data.key;
};


/**
 * Aligns the virtual Element definition with the actual DOM, moving the
 * corresponding DOM node to the correct location or creating it if necessary.
 * @param {string} nodeName For an Element, this should be a valid tag string.
 *     For a Text, this should be #text.
 * @param {?string=} key The key used to identify this element.
 * @param {?Array<*>=} statics For an Element, this should be an array of
 *     name-value pairs.
 */
const alignWithDOM = function(nodeName, key, statics) {
  if (currentNode && matches(nodeName, key)) {
    return;
  }

  const parentData = getData(currentParent);
  const keyMap = parentData.keyMap;
  let node;

  // Check to see if the node has moved within the parent.
  if (key) {
    node = keyMap[key];
    if (node && process.env.NODE_ENV !== 'production') {
      assertKeyedTagMatches(getData(node).nodeName, nodeName, key);
    }
  }

  // Create the node if it doesn't exist.
  if (!node) {
    if (nodeName === '#text') {
      node = createText(doc);
    } else {
      node = createElement(doc, currentParent, nodeName, key, statics);
    }

    if (key) {
      keyMap[key] = node;
    }

    context.markCreated(node);
  }

  // If the node has a key, remove it from the DOM to prevent a large number
  // of re-orders in the case that it moved far or was completely removed.
  // Since we hold on to a reference through the keyMap, we can always add it
  // back.
  if (currentNode && getData(currentNode).key) {
    currentParent.replaceChild(node, currentNode);
    parentData.keyMapValid = false;
  } else {
    currentParent.insertBefore(node, currentNode);
  }

  currentNode = node;
};


/**
 * @param {?Node} node
 * @param {?Node} child
 * @param {?Object<string, !Element>} keyMap
 */
const removeChild = function(node, child, keyMap) {
  node.removeChild(child);
  context.markDeleted(/** @type {!Node}*/(child));

  const key = getData(child).key;
  if (key) {
    delete keyMap[key];
  }
};

/**
 * Clears out any unvisited Nodes, as the corresponding virtual element
 * functions were never called for them.
 */
const clearUnvisitedDOM = function() {
  const node = currentParent;
  const data = getData(node);
  const keyMap = data.keyMap;
  const keyMapValid = data.keyMapValid;
  let child = node.lastChild;
  let key;

  if (child === currentNode && keyMapValid) {
    return;
  }

  while (child !== currentNode) {
    removeChild(node, child, keyMap);
    child = node.lastChild;
  }

  // Clean the keyMap, removing any unusued keys.
  if (!keyMapValid) {
    for (key in keyMap) {
      child = keyMap[key];
      if (child.parentNode !== node) {
        context.markDeleted(child);
        delete keyMap[key];
      }
    }

    data.keyMapValid = true;
  }
};


/**
 * Changes to the first child of the current node.
 */
const enterNode = function() {
  currentParent = currentNode;
  currentNode = null;
};


/**
 * Changes to the next sibling of the current node.
 */
const nextNode = function() {
  if (currentNode) {
    currentNode = currentNode.nextSibling;
  } else {
    currentNode = currentParent.firstChild;
  }
};


/**
 * Changes to the parent of the current node, removing any unvisited children.
 */
const exitNode = function() {
  clearUnvisitedDOM();

  currentNode = currentParent;
  currentParent = currentParent.parentNode;
};


/**
 * Makes sure that the current node is an Element with a matching tagName and
 * key.
 *
 * @param {string} tag The element's tag.
 * @param {?string=} key The key used to identify this element. This can be an
 *     empty string, but performance may be better if a unique value is used
 *     when iterating over an array of items.
 * @param {?Array<*>=} statics An array of attribute name/value pairs of the
 *     static attributes for the Element. These will only be set once when the
 *     Element is created.
 * @return {!Element} The corresponding Element.
 */
const elementOpen = function(tag, key, statics) {
  nextNode();
  alignWithDOM(tag, key, statics);
  enterNode();
  return /** @type {!Element} */(currentParent);
};


/**
 * Closes the currently open Element, removing any unvisited children if
 * necessary.
 *
 * @return {!Element} The corresponding Element.
 */
const elementClose = function() {
  if (process.env.NODE_ENV !== 'production') {
    setInSkip(false);
  }

  exitNode();
  return /** @type {!Element} */(currentNode);
};


/**
 * Makes sure the current node is a Text node and creates a Text node if it is
 * not.
 *
 * @return {!Text} The corresponding Text Node.
 */
const text = function() {
  nextNode();
  alignWithDOM('#text', null, null);
  return /** @type {!Text} */(currentNode);
};


/**
 * Gets the current Element being patched.
 * @return {!Element}
 */
const currentElement = function() {
  if (process.env.NODE_ENV !== 'production') {
    assertInPatch(context);
    assertNotInAttributes('currentElement');
  }
  return /** @type {!Element} */(currentParent);
};


/**
 * Skips the children in a subtree, allowing an Element to be closed without
 * clearing out the children.
 */
const skip = function() {
  if (process.env.NODE_ENV !== 'production') {
    assertNoChildrenDeclaredYet('skip', currentNode);
    setInSkip(true);
  }
  currentNode = currentParent.lastChild;
};


/** */
export {
  elementOpen,
  elementClose,
  text,
  patchInner,
  patchOuter,
  currentElement,
  skip
};
