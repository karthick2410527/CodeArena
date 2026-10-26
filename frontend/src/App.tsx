import { Navigate, Route, Routes } from "react-router-dom";
import Layout from "./components/Layout";
import ProtectedRoute from "./auth/ProtectedRoute";
import AdminRoute from "./auth/AdminRoute";
import ProblemListPage from "./pages/ProblemListPage";
import ProblemDetailPage from "./pages/ProblemDetailPage";
import LoginPage from "./pages/LoginPage";
import RegisterPage from "./pages/RegisterPage";
import ForgotPasswordPage from "./pages/ForgotPasswordPage";
import ProfilePage from "./pages/ProfilePage";
import SubmissionsPage from "./pages/SubmissionsPage";
import SubmissionDetailPage from "./pages/SubmissionDetailPage";
import AdminProblemsPage from "./pages/admin/AdminProblemsPage";
import AdminProblemEditPage from "./pages/admin/AdminProblemEditPage";
import AdminOpsPage from "./pages/admin/AdminOpsPage";
import NotFoundPage from "./pages/NotFoundPage";
import HomePage from "./pages/HomePage";
import AuthCallbackPage from "./pages/AuthCallbackPage";
import ScrollToTop from "./components/ScrollToTop";
import ReplayPage from "./pages/ReplayPage";
import UserProfilePage from "./pages/UserProfilePage";
import PeoplePage from "./pages/PeoplePage";
import ContestsPage from "./pages/contests/ContestsPage";
import ContestLayout, {
  ContestEditorial,
  ContestOverview,
  ContestStandings,
  ContestSubmissions,
} from "./pages/contests/ContestPage";
import ContestProblemPage from "./pages/contests/ContestProblemPage";
import ContestEditPage from "./pages/contests/ContestEditPage";
import MyContestsPage from "./pages/contests/MyContestsPage";
import PricingPage from "./pages/PricingPage";

export default function App() {
  return (
    <>
    <ScrollToTop />
    <Routes>
      {/* Full-screen pages with their own chrome. */}
      <Route path="login" element={<LoginPage />} />
      <Route path="register" element={<RegisterPage />} />
      <Route path="forgot-password" element={<ForgotPasswordPage />} />
      <Route path="auth/callback" element={<AuthCallbackPage />} />

      <Route element={<Layout />}>
        <Route index element={<HomePage />} />
        <Route path="problems" element={<ProblemListPage />} />
        <Route path="problems/:slug" element={<ProblemDetailPage />} />
        <Route path="contests" element={<ContestsPage />} />
        <Route path="contests/:slug" element={<ContestLayout />}>
          <Route index element={<ContestOverview />} />
          <Route path="problems/:label" element={<ContestProblemPage />} />
          <Route path="standings" element={<ContestStandings />} />
          <Route path="editorial" element={<ContestEditorial />} />
          <Route element={<ProtectedRoute />}>
            <Route path="submissions" element={<ContestSubmissions />} />
          </Route>
        </Route>
        <Route path="u/:username" element={<UserProfilePage />} />
        <Route path="people" element={<PeoplePage />} />
        <Route path="pricing" element={<PricingPage />} />

        {/* Signed-in users only. */}
        <Route element={<ProtectedRoute />}>
          <Route path="profile" element={<ProfilePage />} />
          <Route path="submissions" element={<SubmissionsPage />} />
          <Route path="submissions/:id" element={<SubmissionDetailPage />} />
          <Route path="replays/:id" element={<ReplayPage />} />
          <Route path="contests/joined" element={<Navigate to="/contests?tab=mine" replace />} />
          <Route path="contests/new" element={<ContestEditPage />} />
          <Route path="contests/:slug/manage" element={<ContestEditPage />} />
          <Route path="studio" element={<Navigate to="/studio/problems" replace />} />
          <Route path="studio/problems" element={<AdminProblemsPage scope="studio" />} />
          <Route path="studio/problems/:id" element={<AdminProblemEditPage scope="studio" />} />
          <Route path="host" element={<MyContestsPage />} />
          <Route path="studio/contests" element={<Navigate to="/host" replace />} />
        </Route>

        {/* Administrators only; the API enforces this independently. */}
        <Route path="admin" element={<AdminRoute />}>
          <Route index element={<Navigate to="/admin/problems" replace />} />
          <Route path="problems" element={<AdminProblemsPage />} />
          <Route path="problems/:id" element={<AdminProblemEditPage />} />
          <Route path="ops" element={<AdminOpsPage />} />
        </Route>

        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
    </>
  );
}
