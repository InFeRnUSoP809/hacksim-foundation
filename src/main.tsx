import "@vly-ai/integrations";
import { Toaster } from "@/components/ui/sonner";
import { ConfirmDialogProvider } from "@/components/ConfirmDialog";
import { RequireAdmin } from "@/components/RequireAdmin";
import { RequireAuth } from "@/components/RequireAuth";
import { ThemeProvider } from "@/lib/theme";
import { VlyToolbar } from "../vly-toolbar-readonly.tsx";
import React, { StrictMode, useEffect, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes, useLocation } from "react-router";
import "./index.css";

// Lazy load route components for better code splitting
const Landing = lazy(() => import("./pages/Landing.tsx"));
const Login = lazy(() => import("./pages/Login.tsx"));
const Signup = lazy(() => import("./pages/Signup.tsx"));
const Dashboard = lazy(() => import("./pages/Dashboard.tsx"));
const HackathonPage = lazy(() => import("./pages/HackathonPage.tsx"));
const MyTeam = lazy(() => import("./pages/MyTeam.tsx"));
const Simulation = lazy(() => import("./pages/Simulation.tsx"));
const SubmissionPage = lazy(() => import("./pages/SubmissionPage.tsx"));
const Workspace = lazy(() => import("./pages/Workspace.tsx"));
const AdminDashboard = lazy(() => import("./pages/admin/AdminDashboard.tsx"));
const AdminHackathons = lazy(() => import("./pages/admin/AdminHackathons.tsx"));
const AdminTeams = lazy(() => import("./pages/admin/AdminTeams.tsx"));
const AdminUsers = lazy(() => import("./pages/admin/AdminUsers.tsx"));
const AdminSimulations = lazy(
  () => import("./pages/admin/AdminSimulations.tsx"),
);
const AdminSubmissions = lazy(
  () => import("./pages/admin/AdminSubmissions.tsx"),
);
const AdminSettings = lazy(() => import("./pages/admin/AdminSettings.tsx"));
const AdminRepositories = lazy(
  () => import("./pages/admin/AdminRepositories.tsx"),
);
const AdminProjectReviews = lazy(
  () => import("./pages/admin/AdminProjectReviews.tsx"),
);
const AdminAI = lazy(() => import("./pages/admin/AdminAI.tsx"));
const AdminSubmissionAnalysis = lazy(
  () => import("./pages/admin/AdminSubmissionAnalysis.tsx"),
);
const AdminDataManagement = lazy(
  () => import("./pages/admin/AdminDataManagement.tsx"),
);
const AdminAuditLog = lazy(() => import("./pages/admin/AdminAuditLog.tsx"));
const AdminPlayground = lazy(() => import("./pages/admin/AdminPlayground.tsx"));
const ProjectReview = lazy(() => import("./pages/ProjectReview.tsx"));
const NotFound = lazy(() => import("./pages/NotFound.tsx"));

// Simple loading fallback for route transitions
function RouteLoading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="flex items-center gap-2.5 text-sm text-muted-foreground">
        <span className="size-1.5 animate-pulse rounded-full bg-signal" />
        Loading…
      </div>
    </div>
  );
}

/** Silent error boundary — if VlyToolbar crashes it renders nothing instead of
 *  crashing the whole app (e.g. hook errors in the browser runtime). */
class ToolbarErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(err: Error) {
    console.warn("[VlyToolbar] Caught error, toolbar disabled:", err.message);
  }
  render() {
    return this.state.hasError ? null : this.props.children;
  }
}

/** Hard guard so runtime errors never leave the preview as a blank page. */
class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; message: string; stack: string }
> {
  state = { hasError: false, message: "", stack: "" };
  static getDerivedStateFromError(error: Error) {
    return {
      hasError: true,
      message: error.message || "Unknown runtime error",
      stack: error.stack || "",
    };
  }
  componentDidCatch(err: Error) {
    console.error("[Preview] Root crash:", err);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-background text-foreground p-6">
          <div className="max-w-lg text-center">
            <p className="text-sm font-semibold">Preview runtime error</p>
            <p className="mt-2 text-xs text-muted-foreground break-words">
              {this.state.message}
            </p>
            {this.state.stack && (
              <pre className="mt-3 text-left text-[10px] leading-4 text-muted-foreground/80 max-h-40 overflow-auto rounded border border-border/60 p-2">
                {this.state.stack}
              </pre>
            )}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function RouteSyncer() {
  const location = useLocation();
  useEffect(() => {
    window.parent.postMessage(
      { type: "iframe-route-change", path: location.pathname },
      "*",
    );
  }, [location.pathname]);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.data?.type === "navigate") {
        if (event.data.direction === "back") window.history.back();
        if (event.data.direction === "forward") window.history.forward();
      }
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  return null;
}

/** Registers the service worker that makes HackSim installable. */
function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    // Register after load so the first paint is never blocked.
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch((err) => {
        console.warn("[hacksim] service worker registration failed:", err);
      });
    });
  }, []);
  return null;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RootErrorBoundary>
      <ToolbarErrorBoundary>
        <VlyToolbar />
      </ToolbarErrorBoundary>
      <ThemeProvider>
        {/* Mounted once at the root: both the admin surface and the student
          workspace ask for confirmations, so a per-layout provider left pages
          like /hackathon and /team without one. */}
        <ConfirmDialogProvider>
          <BrowserRouter>
            <RouteSyncer />
            <ServiceWorkerRegistrar />
            <Suspense fallback={<RouteLoading />}>
              <Routes>
                <Route path="/" element={<Landing />} />
                <Route path="/login" element={<Login />} />
                <Route path="/signup" element={<Signup />} />
                <Route
                  path="/dashboard"
                  element={
                    <RequireAuth
                      title="Sign in to open your dashboard"
                      description="Your training progress lives in a HackSim account."
                      redirectImmediately
                    >
                      <Dashboard />
                    </RequireAuth>
                  }
                />
                <Route
                  path="/hackathon"
                  element={
                    <RequireAuth redirectImmediately>
                      <HackathonPage />
                    </RequireAuth>
                  }
                />
                <Route
                  path="/team"
                  element={
                    <RequireAuth redirectImmediately>
                      <MyTeam />
                    </RequireAuth>
                  }
                />
                <Route
                  path="/simulation/:sessionId"
                  element={
                    <RequireAuth redirectImmediately>
                      <Simulation />
                    </RequireAuth>
                  }
                />
                <Route
                  path="/submission/:sessionId"
                  element={
                    <RequireAuth redirectImmediately>
                      <SubmissionPage />
                    </RequireAuth>
                  }
                />
                <Route
                  path="/review/:id"
                  element={
                    <RequireAuth
                      title="Sign in to open your review"
                      description="Your project review is tied to your account."
                      redirectImmediately
                    >
                      <ProjectReview />
                    </RequireAuth>
                  }
                />
                <Route
                  path="/workspace"
                  element={
                    <RequireAuth
                      title="Sign in to open your workspace"
                      description="Your submissions and material are tied to your account."
                      redirectImmediately
                    >
                      <Workspace />
                    </RequireAuth>
                  }
                />
                <Route
                  path="/admin"
                  element={
                    <RequireAdmin>
                      <AdminDashboard />
                    </RequireAdmin>
                  }
                />
                <Route
                  path="/admin/hackathons"
                  element={
                    <RequireAdmin>
                      <AdminHackathons />
                    </RequireAdmin>
                  }
                />
                <Route
                  path="/admin/teams"
                  element={
                    <RequireAdmin>
                      <AdminTeams />
                    </RequireAdmin>
                  }
                />
                <Route
                  path="/admin/users"
                  element={
                    <RequireAdmin>
                      <AdminUsers />
                    </RequireAdmin>
                  }
                />
                <Route
                  path="/admin/simulations"
                  element={
                    <RequireAdmin>
                      <AdminSimulations />
                    </RequireAdmin>
                  }
                />
                <Route
                  path="/admin/submissions"
                  element={
                    <RequireAdmin>
                      <AdminSubmissions />
                    </RequireAdmin>
                  }
                />
                <Route
                  path="/admin/repositories"
                  element={
                    <RequireAdmin>
                      <AdminRepositories />
                    </RequireAdmin>
                  }
                />
                <Route
                  path="/admin/project-reviews"
                  element={
                    <RequireAdmin>
                      <AdminProjectReviews />
                    </RequireAdmin>
                  }
                />
                <Route
                  path="/admin/ai"
                  element={
                    <RequireAdmin>
                      <AdminAI />
                    </RequireAdmin>
                  }
                />
                <Route
                  path="/admin/submissions/:id"
                  element={
                    <RequireAdmin>
                      <AdminSubmissionAnalysis />
                    </RequireAdmin>
                  }
                />
                <Route
                  path="/admin/settings"
                  element={
                    <RequireAdmin>
                      <AdminSettings />
                    </RequireAdmin>
                  }
                />
                <Route
                  path="/admin/data-management"
                  element={
                    <RequireAdmin>
                      <AdminDataManagement />
                    </RequireAdmin>
                  }
                />
                <Route
                  path="/admin/audit-log"
                  element={
                    <RequireAdmin>
                      <AdminAuditLog />
                    </RequireAdmin>
                  }
                />
                <Route
                  path="/admin/playground"
                  element={
                    <RequireAdmin>
                      <AdminPlayground />
                    </RequireAdmin>
                  }
                />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </Suspense>
          </BrowserRouter>
          <Toaster />
        </ConfirmDialogProvider>
      </ThemeProvider>
    </RootErrorBoundary>
  </StrictMode>,
);
