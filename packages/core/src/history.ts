/**
 * Browser history integration and popstate management.
 */

export interface HistoryOptions {
  replace?: boolean;
}

export type PopStateCallback = (url: string) => void;

export class HistoryManager {
  private popStateCallback?: PopStateCallback;
  private isBrowser: boolean;
  private isListening = false;

  constructor() {
    this.isBrowser = typeof window !== "undefined" && typeof window.history !== "undefined";
  }

  onPopState(cb: PopStateCallback): () => void {
    this.popStateCallback = cb;
    if (this.isBrowser && !this.isListening) {
      window.addEventListener("popstate", this.handlePopState);
      this.isListening = true;
    }
    return () => {
      if (this.popStateCallback === cb) {
        this.popStateCallback = undefined;
        if (this.isBrowser && this.isListening) {
          window.removeEventListener("popstate", this.handlePopState);
          this.isListening = false;
        }
      }
    };
  }

  push(url: string): void {
    if (this.isBrowser) {
      window.history.pushState({ fluxfast: true, url }, "", url);
    }
  }

  replace(url: string): void {
    if (this.isBrowser) {
      window.history.replaceState({ fluxfast: true, url }, "", url);
    }
  }

  destroy(): void {
    if (this.isBrowser && this.isListening) {
      window.removeEventListener("popstate", this.handlePopState);
      this.isListening = false;
    }
    this.popStateCallback = undefined;
  }

  private handlePopState = (_event: PopStateEvent): void => {
    if (this.popStateCallback && typeof window !== "undefined") {
      const url = window.location.pathname + window.location.search + window.location.hash;
      this.popStateCallback(url);
    }
  };
}
