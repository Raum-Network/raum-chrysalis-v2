import type { MetadataRoute } from "next";
import { absoluteUrl, seoRoutes } from "../lib/seo";

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();

  return seoRoutes.map((route) => ({
    url: absoluteUrl(route.path),
    lastModified: now,
    changeFrequency: route.changeFrequency,
    priority: route.priority
  }));
}
