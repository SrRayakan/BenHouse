import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'BenHouse v0.4',
  description: 'Foundation técnica de BenHouse v0.4.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
