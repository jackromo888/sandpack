import type {
  BundlerState,
  ListenerFunction,
  ReactDevToolsMode,
  SandpackError,
  SandpackMessage,
  UnsubscribeFunction,
} from "@codesandbox/sandpack-client";
import { extractErrorDetails } from "@codesandbox/sandpack-client";
import { SandpackClient } from "@codesandbox/sandpack-client";
import { useCallback, useEffect, useRef, useState } from "react";

import type {
  SandpackInitMode,
  SandpackProviderProps,
  SandpackStatus,
} from "../..";

import type { FilesState } from "./useFiles";

const BUNDLER_TIMEOUT = 30000; // 30 seconds timeout for the bundler to respond.

interface SandpackConfigState {
  reactDevTools?: ReactDevToolsMode;
  startRoute?: string;
  initMode: SandpackInitMode;
  bundlerState?: BundlerState;
  error: SandpackError | null;
  sandpackStatus: SandpackStatus;
}

type UseClient = (
  props: SandpackProviderProps,
  fileState: FilesState
) => [
  SandpackConfigState,
  {
    initializeSandpackIframe: () => void;
    runSandpack: () => void;
    unregisterBundler: (clientId: string) => void;
    registerReactDevTools: (value: ReactDevToolsMode) => void;
  }
];

export const useClient: UseClient = (props, fileState) => {
  const initModeFromProps = props.options?.initMode || "lazy";

  const [state, setState] = useState<SandpackConfigState>({
    startRoute: props.options?.startRoute,
    bundlerState: undefined,
    error: null,
    initMode: initModeFromProps,
    reactDevTools: undefined,
    sandpackStatus: props.options?.autorun ?? true ? "initial" : "idle",
  });

  /**
   * Refs
   */
  const intersectionObserver = useRef<IntersectionObserver>(null);
  const lazyAnchorRef = useRef<HTMLDivElement>(null);
  const initializeSandpackIframeHook = useRef<NodeJS.Timer | null>(null);
  const preregisteredIframes = useRef<Record<string, HTMLIFrameElement>>({});
  const clients = useRef<Record<string, SandpackClient>>({});
  const timeoutHook = useRef<NodeJS.Timer | null>(null);
  const unsubscribeClientListeners = useRef<
    Record<string, Record<string, UnsubscribeFunction>>
  >({});
  const unsubscribe = useRef<() => void | undefined>();
  const queuedListeners = useRef<
    Record<string, Record<string, ListenerFunction>>
  >({});
  const debounceHook = useRef<number | undefined>();

  /**
   * Callbacks
   */
  const createClient = useCallback(
    (iframe: HTMLIFrameElement, clientId: string): SandpackClient => {
      const client = new SandpackClient(
        iframe,
        {
          files: fileState.files,
          template: fileState.environment,
        },
        {
          externalResources: props.options?.externalResources,
          bundlerURL: props.options?.bundlerURL,
          startRoute: props.options?.startRoute,
          fileResolver: props.options?.fileResolver,
          skipEval: props.options?.skipEval ?? false,
          logLevel: props.options?.logLevel,
          showOpenInCodeSandbox: true,
          showErrorScreen: true,
          showLoadingScreen: true,
          reactDevTools: state.reactDevTools,
          customNpmRegistries: props.customSetup?.npmRegistries?.map(
            (config) =>
              ({
                ...config,
                proxyEnabled: false, // force
              } ?? [])
          ),
        }
      );

      /**
       * Subscribe inside the context with the first client that gets instantiated.
       * This subscription is for global states like error and timeout, so no need for a per client listen
       * Also, set the timeout timer only when the first client is instantiated
       */
      if (typeof unsubscribe.current !== "function") {
        unsubscribe.current = client.listen(handleMessage);

        timeoutHook.current = setTimeout(() => {
          setState((prev) => ({ ...prev, sandpackStatus: "timeout" }));
        }, BUNDLER_TIMEOUT);
      }

      unsubscribeClientListeners.current[clientId] =
        unsubscribeClientListeners.current[clientId] || {};

      /**
       * Register any potential listeners that subscribed before sandpack ran
       */
      if (queuedListeners.current[clientId]) {
        Object.keys(queuedListeners.current[clientId]).forEach((listenerId) => {
          const listener = queuedListeners.current[clientId][listenerId];
          const unsubscribe = client.listen(listener) as () => void;
          unsubscribeClientListeners.current[clientId][listenerId] =
            unsubscribe;
        });

        // Clear the queued listeners after they were registered
        queuedListeners.current[clientId] = {};
      }

      /**
       * Register global listeners
       */
      const globalListeners = Object.entries(queuedListeners.current.global);
      globalListeners.forEach(([listenerId, listener]) => {
        const unsubscribe = client.listen(listener) as () => void;
        unsubscribeClientListeners.current[clientId][listenerId] = unsubscribe;

        /**
         * Important: Do not clean the global queue
         * Instead of cleaning the queue, keep it there for the
         * following clients that might be created
         */
      });

      return client;
    },
    [
      fileState.environment,
      fileState.files,
      props.customSetup?.npmRegistries,
      props.options?.bundlerURL,
      props.options?.externalResources,
      props.options?.fileResolver,
      props.options?.logLevel,
      props.options?.skipEval,
      props.options?.startRoute,
      state.reactDevTools,
    ]
  );

  const unregisterAllClients = useCallback((): void => {
    Object.keys(clients.current).map(unregisterBundler);

    if (typeof unsubscribe.current === "function") {
      unsubscribe.current();
      unsubscribe.current = undefined;
    }
  }, []);

  const runSandpack = useCallback((): void => {
    Object.keys(preregisteredIframes.current).forEach((clientId) => {
      const iframe = preregisteredIframes.current[clientId];
      clients.current[clientId] = createClient(iframe, clientId);
    });

    setState((prev) => ({ ...prev, sandpackStatus: "running" }));
  }, [createClient]);

  const initializeSandpackIframe = useCallback((): void => {
    const autorun = props.options?.autorun ?? true;

    if (!autorun) {
      return;
    }

    const observerOptions = props.options?.initModeObserverOptions ?? {
      rootMargin: `1000px 0px`,
    };

    if (intersectionObserver.current && lazyAnchorRef.current) {
      intersectionObserver.current?.unobserve(lazyAnchorRef.current);
    }

    if (lazyAnchorRef.current && state.initMode === "lazy") {
      // If any component registerd a lazy anchor ref component, use that for the intersection observer
      intersectionObserver.current = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          // Delay a cycle so all hooks register the refs for the sub-components (open in csb, loading, error overlay)
          initializeSandpackIframeHook.current = setTimeout(() => {
            runSandpack();
          }, 50);

          if (lazyAnchorRef.current) {
            intersectionObserver.current?.unobserve(lazyAnchorRef.current);
          }
        }
      }, observerOptions);

      intersectionObserver.current.observe(lazyAnchorRef.current);
    } else if (lazyAnchorRef.current && state.initMode === "user-visible") {
      intersectionObserver.current = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          // Delay a cycle so all hooks register the refs for the sub-components (open in csb, loading, error overlay)
          initializeSandpackIframeHook.current = setTimeout(() => {
            runSandpack();
          }, 50);
        } else {
          if (initializeSandpackIframeHook.current) {
            clearTimeout(initializeSandpackIframeHook.current);
          }

          Object.keys(clients.current).map(unregisterBundler);
          unregisterAllClients();
        }
      }, observerOptions);

      intersectionObserver.current.observe(lazyAnchorRef.current);
    } else {
      // else run the sandpack on mount, with a slight delay to allow all subcomponents to mount/register components
      initializeSandpackIframeHook.current = setTimeout(
        () => runSandpack(),
        50
      );
    }
  }, [
    props.options?.autorun,
    props.options?.initModeObserverOptions,
    runSandpack,
    state.initMode,
    unregisterAllClients,
  ]);

  const unregisterBundler = (clientId: string): void => {
    const client = clients.current[clientId];
    if (client) {
      client.cleanup();
      client.iframe.contentWindow?.location.replace("about:blank");
      delete clients.current[clientId];
    } else {
      delete preregisteredIframes.current[clientId];
    }

    if (timeoutHook.current) {
      clearTimeout(timeoutHook.current);
    }

    const unsubscribeQueuedClients = Object.values(
      unsubscribeClientListeners.current
    );

    // Unsubscribing all listener registered
    unsubscribeQueuedClients.forEach((listenerOfClient) => {
      const listenerFunctions = Object.values(listenerOfClient);
      listenerFunctions.forEach((unsubscribe) => unsubscribe());
    });

    setState((prev) => ({ ...prev, sandpackStatus: "idle" }));
  };

  const handleMessage = (msg: SandpackMessage): void => {
    if (timeoutHook.current) {
      clearTimeout(timeoutHook.current);
    }

    if (msg.type === "state") {
      setState((prev) => ({ ...prev, bundlerState: msg.state }));
    } else if (msg.type === "done" && !msg.compilatonError) {
      setState((prev) => ({ ...prev, error: null }));
    } else if (msg.type === "action" && msg.action === "show-error") {
      setState((prev) => ({ ...prev, error: extractErrorDetails(msg) }));
    } else if (
      msg.type === "action" &&
      msg.action === "notification" &&
      msg.notificationType === "error"
    ) {
      setState((prev) => ({
        ...prev,
        error: { message: msg.title },
      }));
    }
  };

  const registerReactDevTools = (value: ReactDevToolsMode): void => {
    setState((prev) => ({ ...prev, reactDevTools: value }));
  };

  const updateClients = useCallback((): void => {
    const recompileMode = props.options?.recompileMode ?? "delayed";
    const recompileDelay = props.options?.recompileDelay ?? 500;

    if (state.sandpackStatus !== "running") {
      return;
    }

    if (recompileMode === "immediate") {
      Object.values(clients.current).forEach((client) => {
        client.updatePreview({
          files: fileState.files,
        });
      });
    }

    if (recompileMode === "delayed") {
      window.clearTimeout(debounceHook.current);
      debounceHook.current = window.setTimeout(() => {
        Object.values(clients.current).forEach((client) => {
          client.updatePreview({
            files: fileState.files,
          });
        });
      }, recompileDelay);
    }
  }, [
    fileState.files,
    props.options?.recompileDelay,
    props.options?.recompileMode,
    state.sandpackStatus,
  ]);

  useEffect(() => {
    updateClients();
  }, [fileState.files, updateClients]);

  useEffect(
    function watchInitMode() {
      if (initModeFromProps !== state.initMode) {
        setState((prev) => ({ ...prev, initMode: initModeFromProps }));

        initializeSandpackIframe();
      }
    },
    [initModeFromProps, state, initializeSandpackIframe]
  );

  return [
    state,
    {
      initializeSandpackIframe,
      runSandpack,
      unregisterBundler,
      registerReactDevTools,
    },
  ];
};