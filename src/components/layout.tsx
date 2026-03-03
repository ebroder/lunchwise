import type { FC, PropsWithChildren } from "hono/jsx";

export const Layout: FC<
  PropsWithChildren<{ title?: string; bare?: boolean }>
> = ({ children, title, bare }) => {
  return (
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>{title ? `${title} - Lunchwise` : "Lunchwise"}</title>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossorigin=""
        />
        <link
          href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&family=DM+Serif+Display&display=swap"
          rel="stylesheet"
        />
        <link rel="stylesheet" href="/styles.css" />
      </head>
      <body class="bg-stone-50 dark:bg-stone-950 text-stone-900 dark:text-stone-100 min-h-screen font-sans">
        {bare ? (
          children
        ) : (
          <>
            <nav class="border-b border-stone-200 dark:border-stone-800">
              <div class="max-w-4xl mx-auto px-6 py-4">
                <a href="/" class="font-serif text-xl">
                  Lunchwise
                </a>
              </div>
            </nav>
            <main class="max-w-4xl mx-auto px-6 py-8">{children}</main>
          </>
        )}
      </body>
    </html>
  );
};
