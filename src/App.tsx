import { Navigate, Route, Routes } from "react-router-dom";
import { AdminPage } from "./admin/AdminPage";
import { AuthProvider } from "./admin/AuthContext";
import { AppLayout } from "./components/layout/AppLayout";
import { FeedbackPage } from "./pages/feedback/FeedbackPage";
import { FloorsPage } from "./pages/floors/FloorsPage";
import { CanteenDiningPage } from "./pages/dining/CanteenDiningPage";
import { MapPage } from "./pages/map/MapPage";
import { OffCampusPage } from "./pages/offcampus/OffCampusPage";
import { OperationsPage } from "./pages/operations/OperationsPage";
import { CollectionFormPage } from "./pages/profile/CollectionFormPage";
import { CollectionListPage } from "./pages/profile/CollectionListPage";
import { ProfilePage } from "./pages/profile/ProfilePage";
import { ShuttlePage } from "./pages/shuttle/ShuttlePage";
import { AccountAuthProvider } from "./lib/auth/AccountAuthContext";
import { AccountGate } from "./pages/profile/AccountGate";

export function App() {
  return (
    <Routes>
      <Route path="/admin/*" element={<AuthProvider><AdminPage /></AuthProvider>} />
      {/*
        用户侧整体挂 AccountAuthProvider：反馈页只是「读」登录状态（登录则署名，未登录
        照样能提），采集路由则由 AccountGate 强制登录 + collect:data。两条链路共用一个
        Provider，因此不会各自重复请求 /api/auth/session。
      */}
      <Route element={<AccountAuthProvider><AppLayout /></AccountAuthProvider>}>
        <Route path="/" element={<Navigate to="/map" replace />} />
        <Route path="/map" element={<MapPage />} />
        <Route path="/shuttle" element={<ShuttlePage />} />
        <Route path="/offcampus" element={<OffCampusPage />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/feedback" element={<FeedbackPage />} />
        <Route element={<AccountGate permission="collect:data" title="志愿者登录" />}>
          <Route path="/collect" element={<CollectionListPage />} />
          <Route path="/collect/:buildingId" element={<CollectionFormPage />} />
        </Route>
        <Route path="/places/:placeId/floors" element={<FloorsPage />} />
        <Route path="/places/:placeId/dining" element={<CanteenDiningPage />} />
        <Route path="/places/:placeId/operations" element={<OperationsPage />} />
      </Route>
    </Routes>
  );
}
