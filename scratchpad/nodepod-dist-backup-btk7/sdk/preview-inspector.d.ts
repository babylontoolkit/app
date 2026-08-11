import type { RequestProxy } from "../request-proxy";
export type InspectWaitUntil = "domcontentloaded" | "load" | "networkidle" | {
    selector: string;
    timeout?: number;
};
export interface InspectTarget {
    port: number;
    selector?: string;
    waitUntil?: InspectWaitUntil;
    timeout?: number;
}
export interface InspectResult<T> {
    port: number;
    url: string;
    capturedAt: number;
    data: T;
    warnings?: string[];
}
export interface InspectAttachOptions {
    port: number;
    iframe: HTMLIFrameElement;
}
export interface InspectRect {
    x: number;
    y: number;
    width: number;
    height: number;
    top: number;
    right: number;
    bottom: number;
    left: number;
}
export interface InspectConsoleEntry {
    level: "log" | "info" | "warn" | "error" | "debug";
    args: unknown[];
    timestamp: number;
}
export interface InspectErrorEntry {
    type: "error" | "rejection";
    message: string;
    stack?: string;
    url?: string;
    line?: number;
    column?: number;
    timestamp: number;
}
export interface InspectDomNode {
    tag: string;
    id?: string;
    class?: string;
    role?: string;
    text?: string;
    rect?: InspectRect;
    children: InspectDomNode[];
}
export interface InspectQueryNode {
    selector: string;
    tag: string;
    text: string;
    rect: InspectRect;
    attributes: Record<string, string>;
    computed: Record<string, string>;
}
export interface InspectA11yNode {
    role: string;
    name: string;
    value?: string;
    children: InspectA11yNode[];
}
export interface InspectA11yViolation {
    id: string;
    impact: "minor" | "moderate";
    description: string;
    nodes: string[];
}
export interface InspectScreenshot {
    blob: Blob;
    mimeType: "image/png";
    width: number;
    height: number;
}
export type InspectEvent = "console" | "error" | "navigation" | "overflow-change" | "dom-mutation";
export interface InspectSnapshot {
    viewport?: unknown;
    documentSize?: unknown;
    overflow?: unknown;
    text?: unknown;
    console?: unknown;
    errors?: unknown;
    navigation?: unknown;
    a11y?: unknown;
    screenshot?: unknown;
}
export declare class PreviewInspectorError extends Error {
}
export declare class PreviewNotAttachedError extends PreviewInspectorError {
}
export declare class PreviewAgentUnavailableError extends PreviewInspectorError {
}
export declare class PreviewInspectionTimeoutError extends PreviewInspectorError {
}
export declare class PreviewScreenshotUnavailableError extends PreviewInspectorError {
}
/** Host side of the opt-in, iframe-scoped preview inspection bridge. */
export declare class PreviewInspector {
    private readonly proxy;
    private readonly instanceId;
    private readonly assertActive;
    private readonly sessions;
    private readonly pending;
    private readonly listeners;
    private enabled;
    private sequence;
    private readonly onMessage;
    constructor(proxy: RequestProxy, instanceId: string, assertActive: () => void);
    enable(): Promise<void>;
    disable(): Promise<void>;
    attach({ port, iframe }: InspectAttachOptions): void;
    detach(port: number): void;
    ports(): Array<{
        port: number;
        url: string | null;
        connected: boolean;
        lastSeen?: number;
    }>;
    on(event: InspectEvent, options: {
        port?: number;
    } | ((data: unknown) => void), maybeHandler?: (data: unknown) => void): () => void;
    viewport(target: InspectTarget): Promise<InspectResult<unknown>>;
    documentSize(target: InspectTarget): Promise<InspectResult<unknown>>;
    overflow(target: InspectTarget): Promise<InspectResult<unknown>>;
    text(target: InspectTarget & {
        visibleOnly?: boolean;
    }): Promise<InspectResult<unknown>>;
    dom(target: InspectTarget & {
        maxDepth?: number;
        maxNodes?: number;
    }): Promise<InspectResult<unknown>>;
    query(target: InspectTarget & {
        selector: string;
    }): Promise<InspectResult<unknown>>;
    console(target: InspectTarget & {
        level?: InspectConsoleEntry["level"];
        since?: number;
    }): Promise<InspectResult<InspectConsoleEntry[]>>;
    errors(target: InspectTarget & {
        since?: number;
    }): Promise<InspectResult<InspectErrorEntry[]>>;
    navigation(target: InspectTarget): Promise<InspectResult<unknown>>;
    a11y(target: InspectTarget & {
        mode?: "tree" | "violations";
    }): Promise<InspectResult<InspectA11yNode | InspectA11yViolation[]>>;
    screenshot(target: InspectTarget & {
        fullPage?: boolean;
        scale?: number;
    }): Promise<InspectResult<InspectScreenshot>>;
    snapshot(target: InspectTarget & {
        include: Array<keyof InspectSnapshot>;
    }): Promise<InspectResult<InspectSnapshot>>;
    dispose(): void;
    private call;
    private handleMessage;
    private rejectPending;
}
