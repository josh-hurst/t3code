import { describe, expect, it } from "vite-plus/test";

import { markdownInlineImageHeroes, markdownWithImageGalleries } from "./markdownImageSources";

describe("markdownInlineImageHeroes", () => {
  it("maps inline thumbnails to the image paragraph above them", () => {
    const swaps = markdownInlineImageHeroes(
      [
        "![Lobby](https://x.test/lobby.png)",
        "",
        "![Shop](https://x.test/shop.png) ![Pass](https://x.test/pass.png 'Pass screen') ![Lobby](https://x.test/lobby.png)",
        "",
        "![Results](results.png)",
        "",
        "Before ![Win](win.png) after",
        "",
        "- ![Listed](listed.png)",
      ].join("\n"),
    );
    expect(Object.fromEntries(swaps)).toEqual({
      "https://x.test/shop.png": { hero: "https://x.test/lobby.png", alt: "Shop", title: null },
      "https://x.test/pass.png": {
        hero: "https://x.test/lobby.png",
        alt: "Pass",
        title: "Pass screen",
      },
      "https://x.test/lobby.png": { hero: "https://x.test/lobby.png", alt: "Lobby", title: null },
      "win.png": { hero: "results.png", alt: "Win", title: null },
      // A list item's image is not a replaceable block, so it is a thumbnail of the one above.
      "listed.png": { hero: "results.png", alt: "Listed", title: null },
    });
  });

  it("leaves inline images alone when no image paragraph precedes them", () => {
    expect(markdownInlineImageHeroes("![a](a.png) ![b](b.png)\n\n![c](c.png)").size).toBe(0);
  });
});

describe("markdownWithImageGalleries", () => {
  it("splits an image-only paragraph into its first image above a row of all of them", () => {
    expect(
      markdownWithImageGalleries("### Shots\n![a](a.png)\n![b](b.png)\n![c](c.png)\n\nAfter"),
    ).toBe(
      "### Shots\n![a](a.png)\n\n\u00a0![a](a.png)\u2002\u2002![b](b.png)\u2002\u2002![c](c.png)\n\nAfter",
    );
  });

  it("widens gaps in a mixed row and leaves code alone", () => {
    expect(
      markdownWithImageGalleries(
        "![hero](h.png)\n\nSee ![a](a.png) ![b](b.png) and ![d](d.png)\n\n> ![x](x.png) ![y](y.png)\n\n```\n![x](x.png) ![y](y.png)\n```",
      ),
    ).toBe(
      "![hero](h.png)\n\nSee ![a](a.png)\u2002\u2002![b](b.png) and ![d](d.png)\n\n> \u00a0![x](x.png)\u2002\u2002![y](y.png)\n\n```\n![x](x.png) ![y](y.png)\n```",
    );
  });
});
