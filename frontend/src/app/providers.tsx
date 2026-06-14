"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { installGlobalLogging, logger } from "@/lib/logger";

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
      }),
  );
  useEffect(() => {
    installGlobalLogging();
    logger.info("app.loaded");
  }, []);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
