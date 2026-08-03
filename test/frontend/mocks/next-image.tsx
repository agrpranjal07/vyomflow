import type { ImgHTMLAttributes } from "react";

// Stand-in for next/image, same reasoning as next-link.tsx: only installed
// in frontend/node_modules, and its real implementation is not a plain
// <img> (it goes through Next's image optimization pipeline) which has no
// meaningful equivalent in jsdom — render a plain <img> instead.
export default function Image({
  src,
  alt,
  width,
  height,
  ...props
}: ImgHTMLAttributes<HTMLImageElement> & { src: string; alt: string; width?: number; height?: number }) {
  return <img src={src} alt={alt} width={width} height={height} {...props} />;
}
