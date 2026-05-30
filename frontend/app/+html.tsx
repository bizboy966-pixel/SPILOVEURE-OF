// @ts-nocheck
import { ScrollViewStyleReset } from "expo-router/html";
import type { PropsWithChildren } from "react";

export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="fr" style={{ height: "100%" }}>
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, shrink-to-fit=no"
        />

        <title>SPILIVERE — Plateforme d'affiliation à matrice binaire</title>
        <meta name="description" content="SPILIVERE — Plateforme de marketing d'affiliation à matrice binaire avec 12 niveaux évolutifs. Développez votre réseau et générez des revenus grâce au système Spillover." />
        <meta name="theme-color" content="#1B5BFF" />
        <meta name="application-name" content="SPILIVERE" />

        <meta property="og:type" content="website" />
        <meta property="og:title" content="SPILIVERE — Plateforme d'affiliation" />
        <meta property="og:description" content="Rejoignez SPILIVERE et développez votre réseau d'affiliation grâce à un système binaire forcé à 12 niveaux." />
        <meta property="og:locale" content="fr_FR" />

        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content="SPILIVERE — Plateforme d'affiliation" />
        <meta name="twitter:description" content="Plateforme de marketing d'affiliation à matrice binaire avec 12 niveaux évolutifs." />

        <ScrollViewStyleReset />
        <style
          dangerouslySetInnerHTML={{
            __html: `
              body > div:first-child { position: fixed !important; top: 0; left: 0; right: 0; bottom: 0; }
              [role="tablist"] [role="tab"] * { overflow: visible !important; }
              [role="heading"], [role="heading"] * { overflow: visible !important; }
            `,
          }}
        />
      </head>
      <body
        style={{
          margin: 0,
          height: "100%",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {children}
      </body>
    </html>
  );
}
