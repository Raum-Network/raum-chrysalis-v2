import type { ReactNode } from "react";
import { Providers } from "../providers";
import "./styles.css";

export const metadata = {
  title: "Chrysalis V2",
  description: "Circle Arc Testnet cross-chain protocol execution demo"
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
