/** Removes executable and externally-referencing SVG content before DOM insertion. */
export function sanitizeSvg(raw: string): string | null {
  const doc = new DOMParser().parseFromString(raw, "image/svg+xml");
  const root = doc.documentElement;
  if (!root || root.tagName.toLowerCase() !== "svg" || doc.querySelector("parsererror")) return null;
  for (const tag of ["script", "foreignObject", "iframe", "object", "embed", "animate", "set"]) {
    for (const node of Array.from(doc.getElementsByTagName(tag))) node.remove();
  }
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  const elements: Element[] = [root];
  while (walker.nextNode()) elements.push(walker.currentNode as Element);
  for (const element of elements) {
    for (const attr of Array.from(element.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim().toLowerCase();
      if (name.startsWith("on")) element.removeAttribute(attr.name);
      else if ((name === "href" || name === "xlink:href") && !value.startsWith("#")) element.removeAttribute(attr.name);
      else if (name === "style" && value.includes("url(")) element.removeAttribute(attr.name);
    }
  }
  return new XMLSerializer().serializeToString(root);
}
