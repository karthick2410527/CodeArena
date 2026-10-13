import { Navigate, Route, Routes } from "react-router-dom";
import Layout from "./components/Layout";
import ProtectedRoute from "./auth/ProtectedRoute";
import AdminRoute from "./auth/AdminRoute";
import ProblemListPage from "./pages/ProblemListPage";
import ProblemDetailPage from "./pages/ProblemDetailPage";
import LoginPage from "./pages/LoginPage";
import RegisterPage from "./pages/RegisterPage";
import ProfilePage from "./pages/ProfilePage";
import SubmissionsPage from "./pages/SubmissionsPage";
import SubmissionDetailPage from "./pages/SubmissionDetailPage";
import AdminProblemsPage from "./pages/admin/AdminProblemsPage";
import AdminProblemEditPage from "./pages/admin/AdminProblemEditPage";
import AdminOpsPage from "./pages/admin/AdminOpsPage";
import NotFoundPage from "./pages/NotFoundPage";

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Navigate to="/problems" replace />} />
        <Route path="problems" element={<ProblemListPage />} />
        <Route path="problems/:slug" element={<ProblemDetailPage />} />
        <Route path="login" element={<LoginPage />} />
        <Route path="register" element={<RegisterPage />} />

        {/* Signed-in users only. */}
        <Route element={<ProtectedRoute />}>
          <Route path="profile" element={<ProfilePage />} />
          <Route path="submissions" element={<SubmissionsPage />} />
          <Route path="submissions/:id" element={<SubmissionDetailPage />} />
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
  );
}
