import type { MetadataRoute } from "next";
import { absoluteUrl, siteUrl } from "../lib/seo";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/"
      },
      {
        userAgent: [
          "Googlebot",
          "Bingbot",
          "OAI-SearchBot",
          "GPTBot",
          "ChatGPT-User",
          "ClaudeBot",
          "PerplexityBot"
        ],
        allow: "/"
      }
    ],
    sitemap: absoluteUrl("/sitemap.xml"),
    host: siteUrl
  };
}
