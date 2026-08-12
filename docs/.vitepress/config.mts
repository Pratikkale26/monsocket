import { defineConfig } from "vitepress";

export default defineConfig({
  title: "monsocket",
  description:
    "Socket.io for Monad — realtime multiplayer rooms where every action is a real onchain transaction. Rooms, presence, events, shared state, free spectating.",
  head: [["link", { rel: "icon", type: "image/svg+xml", href: "/logo.svg" }]],
  // Emit extensionless links. Vercel's own `cleanUrls` (docs/vercel.json)
  // resolves them to the .html files VitePress still writes. Without both,
  // every link shared by hand — /guide/latency — 404s.
  cleanUrls: true,
  themeConfig: {
    logo: "/logo.svg",
    nav: [
      { text: "Guide", link: "/guide/quickstart" },
      { text: "API", link: "/reference/api" },
      { text: "Play The Vault", link: "https://escapemonsocket.vercel.app" },
    ],
    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "Quickstart", link: "/guide/quickstart" },
          { text: "Concepts", link: "/guide/concepts" },
          { text: "Latency", link: "/guide/latency" },
          { text: "The Vault (demo)", link: "/guide/the-vault" },
        ],
      },
      {
        text: "Reference",
        items: [{ text: "API", link: "/reference/api" }],
      },
    ],
    socialLinks: [
      { icon: "github", link: "https://github.com/Pratikkale26/monsocket" },
    ],
    footer: {
      message: "MIT Licensed",
      copyright: "© 2026 Pratik Kale",
    },
    search: { provider: "local" },
  },
});
