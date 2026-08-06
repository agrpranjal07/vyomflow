import { describe, it, expect } from "vitest";
import { extractCandidateUrls } from "@/trigger/turn";

describe("extractCandidateUrls", () => {
  it("pulls a URL out of a flat string field", () => {
    expect(extractCandidateUrls({ image_url: "https://a.png" })).toEqual(["https://a.png"]);
  });

  it("pulls URLs out of an array-of-strings field", () => {
    expect(extractCandidateUrls({ video_urls: ["https://a.mp4", "https://b.mp4"] })).toEqual([
      "https://a.mp4",
      "https://b.mp4",
    ]);
  });

  it("ignores a non-URL string field", () => {
    expect(extractCandidateUrls({ prompt: "a cat wearing a hat" })).toEqual([]);
  });

  it("ignores non-string/non-array fields (numbers, booleans, objects)", () => {
    expect(extractCandidateUrls({ width_px: 100, keep: true, meta: { x: 1 } })).toEqual([]);
  });

  it("ignores non-URL entries within an array while keeping the URL ones", () => {
    expect(extractCandidateUrls({ items: ["not-a-url", "https://c.mp4", 42] })).toEqual(["https://c.mp4"]);
  });

  it("collects candidate URLs across multiple fields in the input", () => {
    expect(
      extractCandidateUrls({ image_url: "https://a.png", extras: ["https://b.png"], label: "unrelated" }),
    ).toEqual(["https://a.png", "https://b.png"]);
  });

  it("returns an empty array for input with no URL-bearing fields", () => {
    expect(extractCandidateUrls({})).toEqual([]);
  });
});
