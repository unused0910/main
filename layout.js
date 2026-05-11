import "../styles/globals.css";

export const metadata = { title: "Buygenix" };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}