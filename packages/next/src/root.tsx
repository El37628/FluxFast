"use client";

import React, { Component, ReactNode, Suspense } from "react";
import { PageEnvelope } from "@fluxfast/core";
import { FluxProvider, useFluxContext } from "./provider.js";
import { usePage } from "./hooks.js";
import { ComponentRegistry, resolveComponent } from "./resolver.js";
import { FluxCacheConfig } from "./config.js";

interface ErrorBoundaryProps {
  children: ReactNode;
  resetKey: string;
  fallback?: (error: Error) => ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidUpdate(previous: ErrorBoundaryProps): void {
    if (previous.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  override render() {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback(this.state.error);
      return (
        <div role="alert" style={{ padding: "2rem", fontFamily: "monospace", color: "#b91c1c" }}>
          <h2>FluxFast Error</h2>
          <pre style={{ whiteSpace: "pre-wrap" }}>{this.state.error.message}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

function ResolvedPage({ component }: { component: string }) {
  const { registry } = useFluxContext();
  const PageComponent = resolveComponent(component, registry);
  return <PageComponent />;
}

function PageRenderer({ fallback }: { fallback?: (error: Error) => ReactNode }) {
  const page = usePage();
  if (!page.component) return null;

  return (
    <ErrorBoundary resetKey={page.component} fallback={fallback}>
      <Suspense fallback={null}>
        <ResolvedPage component={page.component} />
      </Suspense>
    </ErrorBoundary>
  );
}

export interface FluxRootProps {
  initialEnvelope?: PageEnvelope;
  registry: ComponentRegistry;
  clientUrl?: string;
  cache?: FluxCacheConfig;
  errorFallback?: (error: Error) => ReactNode;
}

export function FluxRoot({
  initialEnvelope,
  registry,
  clientUrl,
  cache,
  errorFallback,
}: FluxRootProps) {
  return (
    <FluxProvider
      initialEnvelope={initialEnvelope}
      registry={registry}
      clientUrl={clientUrl}
      cache={cache}
    >
      <PageRenderer fallback={errorFallback} />
    </FluxProvider>
  );
}
