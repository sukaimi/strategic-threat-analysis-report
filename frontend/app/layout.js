import { Inter } from 'next/font/google';
import './globals.css';

const inter = Inter({ subsets: ['latin'], display: 'swap' });

export const metadata = {
  title: 'STAR MERLION — Maritime Intelligence',
  description: 'Strategic Threat Analysis Report — Maritime Intelligence Dashboard for the Singapore Strait',
  manifest: '/manifest.json',
  themeColor: '#003A70',
  viewport: {
    width: 'device-width',
    initialScale: 1,
    maximumScale: 1,
    userScalable: false,
    viewportFit: 'cover',
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'STAR MERLION',
  },
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={inter.className}>
      <head>
        <link rel="manifest" href="/manifest.json" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="STAR MERLION" />
      </head>
      <body className="bg-saf-light text-saf-dark antialiased">
        {children}
      </body>
    </html>
  );
}
