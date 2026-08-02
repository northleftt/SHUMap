import { Navigate, Route, Routes } from "react-router-dom";
import { AdminPage } from "./admin/AdminPage";
import { AuthProvider } from "./admin/AuthContext";
import { AppLayout } from "./components/layout/AppLayout";
import { FeedbackPage } from "./pages/feedback/FeedbackPage";
import { FloorsPage } from "./pages/floors/FloorsPage";
import { MapPage } from "./pages/map/MapPage";
import { OffCampusPage } from "./pages/offcampus/OffCampusPage";
import { OperationsPage } from "./pages/operations/OperationsPage";
import { CollectionFormPage } from "./pages/profile/CollectionFormPage";
import { CollectionListPage } from "./pages/profile/CollectionListPage";
import { ProfilePage } from "./pages/profile/ProfilePage";
import { ShuttlePage } from "./pages/shuttle/ShuttlePage";
import { VolunteerAuthProvider } from "./lib/auth/VolunteerAuthContext";
import { VolunteerGate } from "./pages/profile/VolunteerGate";

export function App() {
  return (
    <Routes>
      <Route path="/admin/*" element={<AuthProvider><AdminPage /></AuthProvider>} />
      <Route element={<AppLayout />}>
        <Route path="/" element={<Navigate to="/map" replace />} />
        <Route path="/map" element={<MapPage />} />
        <Route path="/shuttle" element={<ShuttlePage />} />
        <Route path="/offcampus" element={<OffCampusPage />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/feedback" element={<FeedbackPage />} />
        <Route element={<VolunteerAuthProvider><VolunteerGate /></VolunteerAuthProvider>}>
          <Route path="/collect" element={<CollectionListPage />} />
          <Route path="/collect/:buildingId" element={<CollectionFormPage />} />
        </Route>
        <Route path="/places/:placeId/floors" element={<FloorsPage />} />
        <Route path="/places/:placeId/operations" element={<OperationsPage />} />
      </Route>
    </Routes>
  );
}
