import { Document, Element, Node } from "@xmldom/xmldom";

/**
 * lib-jitsi / Strophe expect browser DOM APIs on XMPP stanza nodes.
 * @xmldom/xmldom omits several methods used in MUC presence handling.
 */
export function installXmlDomPolyfills(): void {
  patchElementQuerySelectors();
  patchElementDomMethods();
  patchDocumentEvents();
}


function patchElementQuerySelectors(): void {
  const proto = Element.prototype as Element & {
    querySelectorAll?: (selector: string) => Element[];
    querySelector?: (selector: string) => Element | null;
  };

  if (proto.querySelectorAll) {
    return;
  }

  proto.querySelectorAll = function querySelectorAll(selector: string): Element[] {
    const path = selector
      .replace(/^:scope\s*>\s*/i, "")
      .split(">")
      .map((part) => part.trim())
      .filter(Boolean);

    if (path.length === 0) {
      return [];
    }

    let current: Element[] = [this];
    for (const tagName of path) {
      const next: Element[] = [];
      for (const element of current) {
        next.push(...directChildElements(element, tagName));
      }
      current = next;
    }
    return current;
  };

  proto.querySelector = function querySelector(selector: string): Element | null {
    return proto.querySelectorAll!.call(this, selector)[0] ?? null;
  };
}

function directChildElements(parent: Element, tagName: string): Element[] {
  const matches: Element[] = [];
  for (let node = parent.firstChild; node; node = node.nextSibling) {
    if (node.nodeType !== node.ELEMENT_NODE) {
      continue;
    }
    const element = node as Element;
    if (element.tagName === tagName || element.nodeName === tagName) {
      matches.push(element);
    }
  }
  return matches;
}

function patchElementDomMethods(): void {
  const proto = Element.prototype as Element & {
    remove?: () => void;
    classList?: DOMTokenList;
  };

  if (!proto.remove) {
    proto.remove = function remove(this: Element) {
      if (this.parentNode) {
        this.parentNode.removeChild(this);
      }
    };
  }

  if (!proto.classList) {
    Object.defineProperty(proto, "classList", {
      get(this: Element) {
        const el = this;
        return {
          add(...tokens: string[]) {
            const current = new Set((el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean));
            for (const token of tokens) {
              current.add(token);
            }
            el.setAttribute("class", Array.from(current).join(" "));
          },
          remove(...tokens: string[]) {
            const current = new Set((el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean));
            for (const token of tokens) {
              current.delete(token);
            }
            const value = Array.from(current).join(" ");
            if (value) {
              el.setAttribute("class", value);
            } else {
              el.removeAttribute("class");
            }
          },
          contains(token: string) {
            return (el.getAttribute("class") ?? "").split(/\s+/).includes(token);
          },
        };
      },
      configurable: true,
    });
  }
}

function patchDocumentEvents(): void {
  const proto = Document.prototype as Document & {
    dispatchEvent?: (event: Event) => boolean;
    addEventListener?: (...args: unknown[]) => void;
    removeEventListener?: (...args: unknown[]) => void;
  };

  if (proto.dispatchEvent) {
    return;
  }

  proto.dispatchEvent = () => false;
  proto.addEventListener = () => undefined;
  proto.removeEventListener = () => undefined;
}
