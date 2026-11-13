import {
  markdownForNativeParsing,
  parseMarkdownDocument,
  type MarkdownNode,
} from "./markdownDocument";

export function markdownImageSources(markdown: string): string[] {
  if (!markdown.includes("![") && !/<img[\s>]/i.test(markdown)) return [];
  const sources = new Set<string>();
  const visit = (node: MarkdownNode) => {
    if (node.type === "image") sources.add(node.url);
    if ("children" in node) node.children.forEach(visit);
  };
  visit(parseMarkdownDocument(markdown));
  return [...sources];
}

export interface MarkdownImageSwap {
  readonly hero: string;
  readonly alt: string | null;
  readonly title: string | null;
}

/**
 * Maps each image inside running text to the nearest image paragraph above it. The native
 * renderer draws the former as small inline thumbnails and only hands the latter to React.
 */
export function markdownInlineImageHeroes(
  markdown: string,
): ReadonlyMap<string, MarkdownImageSwap> {
  const swaps = new Map<string, MarkdownImageSwap>();
  if (!markdown.includes("![") && !/<img[\s>]/i.test(markdown)) return swaps;
  let hero: string | null = null;
  const visit = (node: MarkdownNode, parent: MarkdownNode | null) => {
    if (node.type === "paragraph") {
      const content = node.children.filter(
        (child) => child.type !== "text" || child.value.trim().length > 0,
      );
      if (
        content.length === 1 &&
        content[0]!.type === "image" &&
        (parent?.type === "root" || parent?.type === "blockquote")
      ) {
        hero = content[0]!.url;
        return;
      }
    }
    if (node.type === "image" && hero !== null && !swaps.has(node.url)) {
      swaps.set(node.url, { hero, alt: node.alt || null, title: node.title || null });
    }
    if ("children" in node) node.children.forEach((child) => visit(child, node));
  };
  visit(parseMarkdownDocument(markdown), null);
  return swaps;
}

// Two en spaces: wider than the typed space but still breakable, so a long row wraps.
const INLINE_IMAGE_GAP = "  ";
// Native renderers draw an image that starts a line full width; a leading non-breaking space
// keeps a thumbnail row's first image inline.
const INLINE_ROW_LEAD = " ";

/**
 * Lays out image runs as a gallery: a top-level paragraph of only images becomes the first image
 * on its own (React draws it, so it can swap) above a thumbnail row of all of them. Other runs of
 * inline images get wider gaps and an inline first image.
 */
export function markdownWithImageGalleries(markdown: string): string {
  if (!markdown.includes("![") && !/<img[\s>]/i.test(markdown)) return markdown;
  const normalized = markdownForNativeParsing(markdown);
  const edits: Array<{ start: number; end: number; content: string }> = [];
  const span = (node: MarkdownNode) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    return start === undefined || end === undefined ? null : { start, end };
  };
  const visit = (node: MarkdownNode, parent: MarkdownNode | null) => {
    if (node.type === "paragraph") {
      const images = node.children.filter((child) => child.type === "image");
      if (images.length >= 2) {
        const imageOnly = node.children.every(
          (child) => child.type === "image" || (child.type === "text" && !child.value.trim()),
        );
        const paragraph = span(node);
        const imageSpans = images.map(span);
        if (imageOnly && parent?.type === "root" && paragraph && imageSpans.every(Boolean)) {
          const sources = imageSpans.map((image) => normalized.slice(image!.start, image!.end));
          edits.push({
            ...paragraph,
            content: `${sources[0]}\n\n${INLINE_ROW_LEAD}${sources.join(INLINE_IMAGE_GAP)}`,
          });
          return;
        }
        node.children.forEach((child, index) => {
          const gap = span(child);
          if (index === 0 && child.type === "image" && gap)
            edits.push({ start: gap.start, end: gap.start, content: INLINE_ROW_LEAD });
          if (
            child.type === "text" &&
            !child.value.trim() &&
            node.children[index - 1]?.type === "image" &&
            node.children[index + 1]?.type === "image" &&
            gap
          )
            edits.push({ ...gap, content: INLINE_IMAGE_GAP });
        });
      }
    }
    if ("children" in node) node.children.forEach((child) => visit(child, node));
  };
  visit(parseMarkdownDocument(normalized), null);
  if (edits.length === 0) return markdown;
  let result = "";
  let offset = 0;
  for (const edit of edits) {
    result += normalized.slice(offset, edit.start) + edit.content;
    offset = edit.end;
  }
  return result + normalized.slice(offset);
}
