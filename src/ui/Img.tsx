import { useState } from "react";
import { thumbUrl } from "../data/photos.ts";

// Sized, lazily loaded, off-main-thread decoded listing photo. Falls back to the original once if the rendition fails.
export default function Img({ src, width, ...rest }: { src: string; width: number } & React.ImgHTMLAttributes<HTMLImageElement>) {
  const [failed, setFailed] = useState(false);
  return <img {...rest} src={failed ? src : thumbUrl(src, width)} loading="lazy" decoding="async" onError={() => setFailed(true)} />;
}
