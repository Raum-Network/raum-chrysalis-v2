import type { MetadataRoute } from "next";
import { siteDescription, siteName } from "../lib/seo";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: `${siteName} by Raum Network`,
    short_name: siteName,
    description: siteDescription,
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#fff7d6",
    theme_color: "#f6d85b",
    categories: ["finance", "productivity", "utilities"],
    icons: [
      {
        src: "/icon.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable"
      },
      {
        src: "/raumv2logo.png",
        sizes: "512x512",
        type: "image/png"
      }
    ]
  };
}
