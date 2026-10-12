import Image from "next/image";
import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import logo from "@/public/magnemite.png";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <>
          <Image
            src={logo}
            alt=""
            width={24}
            height={24}
            // The source art is 1254px square; the copy under public/ is
            // already downscaled to 128, so no optimizer is in the path.
            unoptimized
            priority
          />
          <span className="font-semibold">Magnemite</span>
        </>
      ),
      transparentMode: "top",
    },
    githubUrl: "https://github.com/pokemaplx/magnemite",
    links: [
      {
        text: "Documentation",
        url: "/docs",
        active: "nested-url",
      },
    ],
  };
}
