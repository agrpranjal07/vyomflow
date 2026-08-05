import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { GeneratedAsset, GeneratedAssetList, classifyAssetUrl } from "@/components/chat/generated-asset";

describe("GeneratedAsset", () => {
  it("renders an image extension as an <img>", () => {
    const { container } = render(<GeneratedAsset url="https://x/out.png" />);
    expect(container.querySelector("img")).toBeInTheDocument();
  });

  it("renders a video extension as a <video> with controls", () => {
    const { container } = render(<GeneratedAsset url="https://x/out.mp4" />);
    expect(container.querySelector("video")).toBeInTheDocument();
    expect(container.querySelector("video")).toHaveAttribute("controls");
  });

  it("renders an audio extension as an <audio> with controls", () => {
    const { container } = render(<GeneratedAsset url="https://x/out.mp3" />);
    expect(container.querySelector("audio")).toBeInTheDocument();
    expect(container.querySelector("audio")).toHaveAttribute("controls");
  });

  it("falls back to a link when an unrecognized/extensionless URL fails to load as an image", () => {
    const { container } = render(<GeneratedAsset url="https://x/result" />);
    const img = container.querySelector("img");
    expect(img).toBeInTheDocument();
    fireEvent.error(img as HTMLImageElement);
    expect(screen.getByRole("link", { name: /open result/i })).toHaveAttribute("href", "https://x/result");
  });

  it("never renders a bare URL as plain text with no media/link affordance", () => {
    render(<GeneratedAsset url="https://x/out.png" />);
    expect(screen.queryByText("https://x/out.png")).not.toBeInTheDocument();
  });
});

describe("classifyAssetUrl — strict classification for message-content.tsx's link/img upgrade (F5/F6)", () => {
  it("classifies recognized image/video/audio extensions", () => {
    expect(classifyAssetUrl("https://x/out.png")).toBe("image");
    expect(classifyAssetUrl("https://x/out.mp4")).toBe("video");
    expect(classifyAssetUrl("https://x/out.mp3")).toBe("audio");
  });

  it("returns null for an unrecognized/extensionless URL — an ordinary link must never be misclassified as media", () => {
    expect(classifyAssetUrl("https://example.com/article")).toBeNull();
    expect(classifyAssetUrl("https://x/result")).toBeNull();
  });
});

describe("GeneratedAssetList", () => {
  it("renders nothing for an empty list", () => {
    const { container } = render(<GeneratedAssetList urls={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders one asset per url", () => {
    const { container } = render(<GeneratedAssetList urls={["https://x/a.png", "https://x/b.mp4"]} />);
    expect(container.querySelectorAll("img").length).toBe(1);
    expect(container.querySelectorAll("video").length).toBe(1);
  });
});
