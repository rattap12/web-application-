import { useEffect, useState } from 'react';
import { supabase } from './supabaseClient';

export default function App() {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState('');

  const [equipments, setEquipments] = useState([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [borrowRecords, setBorrowRecords] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [loginLogs, setLoginLogs] = useState([]);

  const [selectedEquipmentId, setSelectedEquipmentId] = useState('');
  const [borrowQty, setBorrowQty] = useState(1);
  const [dueDate, setDueDate] = useState('');
  const [statusMessage, setStatusMessage] = useState('');

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session ?? null);
      if (data.session?.user) {
        loadUserData(data.session.user.id);
      }
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession ?? null);
      if (newSession?.user) {
        loadUserData(newSession.user.id);
      } else {
        setProfile(null);
        setBorrowRecords([]);
        setNotifications([]);
        setLoginLogs([]);
      }
    });

    return () => listener.subscription.unsubscribe();
  }, []);

  async function loadUserData(userId) {
    const { data: prof } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single();

    setProfile(prof ?? null);
    await Promise.all([
      fetchEquipments(),
      fetchBorrowRecords(userId, prof?.role),
      fetchNotifications(userId),
      prof?.role === 'admin' || prof?.role === 'teacher' ? fetchLoginLogs() : Promise.resolve(),
    ]);
  }

  async function fetchEquipments() {
    const { data } = await supabase
      .from('equipments')
      .select('*')
      .order('asset_code', { ascending: true });
    const list = data ?? [];
    setEquipments(list);
    if (list.length > 0 && !selectedEquipmentId) {
      setSelectedEquipmentId(String(list[0].id));
    }
  }

  async function fetchBorrowRecords(userId, role) {
    let query = supabase
      .from('borrow_records')
      .select('*, equipments(name, asset_code), profiles(full_name, code, role)')
      .order('borrow_date', { ascending: false });

    if (role !== 'admin' && role !== 'teacher') {
      query = query.eq('user_id', userId);
    }

    const { data } = await query;
    const records = data ?? [];
    setBorrowRecords(records);

    // ตรวจสอบรายการที่ใกล้ครบกำหนด หรือเกินกำหนด เพื่อสร้างแจ้งเตือนในเว็บแอป
    await syncDueNotifications(records);
  }

  async function syncDueNotifications(records) {
    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;

    for (const rec of records) {
      if (rec.status !== 'borrowed' || !rec.due_date) continue;
      const dueMs = new Date(rec.due_date).getTime();
      const eqName = rec.equipments?.name || 'อุปกรณ์';

      if (dueMs < now && !rec.notified_overdue) {
        await supabase.from('notifications').insert({
          user_id: rec.user_id,
          title: 'เกินกำหนดคืนอุปกรณ์',
          message: `รายการ "${eqName}" (จำนวน ${rec.quantity}) เลยกำหนดคืนแล้ว กรุณานำส่งคืน`,
        });
        await supabase
          .from('borrow_records')
          .update({ notified_overdue: true, status: 'overdue' })
          .eq('id', rec.id);
      } else if (dueMs >= now && dueMs - now <= oneDayMs && !rec.notified_due_soon) {
        await supabase.from('notifications').insert({
          user_id: rec.user_id,
          title: 'ใกล้ถึงกำหนดคืนอุปกรณ์',
          message: `รายการ "${eqName}" (จำนวน ${rec.quantity}) จะครบกำหนดคืนภายใน 24 ชั่วโมง`,
        });
        await supabase
          .from('borrow_records')
          .update({ notified_due_soon: true })
          .eq('id', rec.id);
      }
    }
  }

  async function fetchNotifications(userId) {
    const { data } = await supabase
      .from('notifications')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    setNotifications(data ?? []);
  }

  async function fetchLoginLogs() {
    const { data } = await supabase
      .from('login_logs')
      .select('*')
      .order('logged_at', { ascending: false })
      .limit(20);
    setLoginLogs(data ?? []);
  }

  async function handleLogin(e) {
    e.preventDefault();
    setAuthLoading(true);
    setAuthError('');

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      await supabase.from('login_logs').insert({
        user_id: null,
        email_used: email,
        status: 'failed',
      });
      setAuthError('เข้าสู่ระบบไม่สำเร็จ: กรุณาตรวจสอบอีเมลและรหัสผ่าน');
      setAuthLoading(false);
      return;
    }

    await supabase.from('login_logs').insert({
      user_id: data.user.id,
      email_used: email,
      status: 'success',
    });

    setAuthLoading(false);
  }

  async function handleLogout() {
    await supabase.auth.signOut();
  }

  async function handleBorrow(e) {
    e.preventDefault();
    setStatusMessage('');
    const qty = Number(borrowQty);
    const eq = equipments.find((item) => String(item.id) === String(selectedEquipmentId));

    if (!eq || qty < 1 || qty > eq.available_qty || !dueDate) {
      setStatusMessage('กรุณาตรวจสอบจำนวนอุปกรณ์ (ต้องไม่เกินจำนวนคงเหลือ) และกำหนดวันคืน');
      return;
    }

    const { error: insertErr } = await supabase.from('borrow_records').insert({
      user_id: session.user.id,
      equipment_id: eq.id,
      quantity: qty,
      due_date: new Date(dueDate).toISOString(),
      status: 'borrowed',
    });

    if (insertErr) {
      setStatusMessage('เกิดข้อผิดพลาดในการบันทึกการยืม');
      return;
    }

    await supabase
      .from('equipments')
      .update({
        available_qty: eq.available_qty - qty,
        updated_at: new Date().toISOString(),
      })
      .eq('id', eq.id);

    setStatusMessage('บันทึกการยืมอุปกรณ์เรียบร้อยแล้ว');
    setBorrowQty(1);
    setDueDate('');
    await loadUserData(session.user.id);
  }

  async function handleReturn(record) {
    setStatusMessage('');
    const condition = window.confirm('อุปกรณ์อยู่ในสภาพปกติใช่หรือไม่? (กด OK = ปกติ, กด Cancel = ชำรุด)')
      ? 'normal'
      : 'damaged';

    await supabase
      .from('borrow_records')
      .update({
        status: 'returned',
        return_date: new Date().toISOString(),
        return_condition: condition,
      })
      .eq('id', record.id);

    if (condition === 'normal') {
      const eq = equipments.find((item) => item.id === record.equipment_id);
      if (eq) {
        await supabase
          .from('equipments')
          .update({
            available_qty: Math.min(eq.total_qty, eq.available_qty + record.quantity),
            updated_at: new Date().toISOString(),
          })
          .eq('id', eq.id);
      }
    }

    setStatusMessage('บันทึกการคืนอุปกรณ์เรียบร้อยแล้ว');
    await loadUserData(session.user.id);
  }

  async function handleMarkRead(notifId) {
    await supabase.from('notifications').update({ is_read: true }).eq('id', notifId);
    if (session?.user) {
      await fetchNotifications(session.user.id);
    }
  }

  if (!session) {
    return (
      <div style={{ maxWidth: 420, margin: '60px auto', padding: 24, fontFamily: 'sans-serif' }}>
        <h2>เข้าสู่ระบบยืม-คืนอุปกรณ์อิเล็กทรอนิกส์</h2>
        <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <input
            type="email"
            placeholder="อีเมลผู้ใช้งาน"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            style={{ padding: 10 }}
          />
          <input
            type="password"
            placeholder="รหัสผ่าน"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            style={{ padding: 10 }}
          />
          <button type="submit" disabled={authLoading} style={{ padding: 10 }}>
            {authLoading ? 'กำลังเข้าสู่ระบบ...' : 'เข้าสู่ระบบ'}
          </button>
          {authError && <p style={{ color: 'crimson' }}>{authError}</p>}
        </form>
      </div>
    );
  }

  const filteredEquipments = equipments.filter(
    (item) =>
      item.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      item.asset_code.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const unreadCount = notifications.filter((n) => !n.is_read).length;

  return (
    <div style={{ maxWidth: 960, margin: '24px auto', padding: 16, fontFamily: 'sans-serif' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h2>ระบบยืม-คืนอุปกรณ์อิเล็กทรอนิกส์</h2>
          <p>
            ผู้ใช้: <strong>{profile?.full_name || session.user.email}</strong> | สิทธิ์:{' '}
            <strong>{profile?.role || 'student'}</strong> | แจ้งเตือนยังไม่อ่าน: <strong>{unreadCount}</strong>
          </p>
        </div>
        <button onClick={handleLogout} style={{ padding: '8px 14px' }}>
          ออกจากระบบ
        </button>
      </header>

      {statusMessage && (
        <div style={{ padding: 12, background: '#eef6ff', marginBottom: 16, borderRadius: 6 }}>
          {statusMessage}
        </div>
      )}

      <section style={{ marginBottom: 28 }}>
        <h3>การแจ้งเตือนในเว็บแอป</h3>
        {notifications.length === 0 ? (
          <p>ไม่มีการแจ้งเตือน</p>
        ) : (
          <ul>
            {notifications.map((n) => (
              <li key={n.id} style={{ marginBottom: 8 }}>
                <strong>[{n.title}]</strong> {n.message}{' '}
                {!n.is_read && (
                  <button onClick={() => handleMarkRead(n.id)} style={{ marginLeft: 8 }}>
                    ทำเครื่องหมายว่าอ่านแล้ว
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section style={{ marginBottom: 28 }}>
        <h3>ทำรายการยืมอุปกรณ์</h3>
        <form onSubmit={handleBorrow} style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          <select
            value={selectedEquipmentId}
            onChange={(e) => setSelectedEquipmentId(e.target.value)}
            style={{ padding: 8 }}
          >
            {equipments.map((eq) => (
              <option key={eq.id} value={eq.id}>
                {eq.asset_code} - {eq.name} (คงเหลือ {eq.available_qty})
              </option>
            ))}
          </select>
          <input
            type="number"
            min="1"
            value={borrowQty}
            onChange={(e) => setBorrowQty(e.target.value)}
            style={{ width: 80, padding: 8 }}
          />
          <input
            type="datetime-local"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            required
            style={{ padding: 8 }}
          />
          <button type="submit" style={{ padding: '8px 16px' }}>
            ยืนยันการยืม
          </button>
        </form>
      </section>

      <section style={{ marginBottom: 28 }}>
        <h3>รายการอุปกรณ์อิเล็กทรอนิกส์</h3>
        <input
          type="text"
          placeholder="ค้นหาชื่ออุปกรณ์ หรือรหัสครุภัณฑ์..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          style={{ padding: 8, width: 280, marginBottom: 12 }}
        />
        <table border="1" cellPadding="8" cellSpacing="0" width="100%">
          <thead>
            <tr>
              <th>รหัส</th>
              <th>ชื่ออุปกรณ์</th>
              <th>หมวดหมู่</th>
              <th>ทั้งหมด</th>
              <th>คงเหลือ</th>
              <th>สถานะ</th>
            </tr>
          </thead>
          <tbody>
            {filteredEquipments.map((eq) => (
              <tr key={eq.id}>
                <td>{eq.asset_code}</td>
                <td>{eq.name}</td>
                <td>{eq.category || '-'}</td>
                <td>{eq.total_qty}</td>
                <td>{eq.available_qty}</td>
                <td>{eq.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section style={{ marginBottom: 28 }}>
        <h3>รายการยืม-คืน</h3>
        <table border="1" cellPadding="8" cellSpacing="0" width="100%">
          <thead>
            <tr>
              <th>อุปกรณ์</th>
              <th>ผู้ยืม</th>
              <th>จำนวน</th>
              <th>กำหนดคืน</th>
              <th>สถานะ</th>
              <th>จัดการ</th>
            </tr>
          </thead>
          <tbody>
            {borrowRecords.map((rec) => (
              <tr key={rec.id}>
                <td>{rec.equipments?.name || rec.equipment_id}</td>
                <td>{rec.profiles?.full_name || rec.user_id}</td>
                <td>{rec.quantity}</td>
                <td>{new Date(rec.due_date).toLocaleString('th-TH')}</td>
                <td>{rec.status}</td>
                <td>
                  {rec.status !== 'returned' ? (
                    <button onClick={() => handleReturn(rec)}>คืนอุปกรณ์</button>
                  ) : (
                    `คืนแล้ว (${rec.return_condition || 'normal'})`
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {(profile?.role === 'admin' || profile?.role === 'teacher') && (
        <section>
          <h3>ประวัติการเข้าสู่ระบบ (ล่าสุด 20 รายการ)</h3>
          <table border="1" cellPadding="8" cellSpacing="0" width="100%">
            <thead>
              <tr>
                <th>อีเมลที่ใช้</th>
                <th>สถานะ</th>
                <th>เวลา</th>
              </tr>
            </thead>
            <tbody>
              {loginLogs.map((log) => (
                <tr key={log.id}>
                  <td>{log.email_used}</td>
                  <td>{log.status}</td>
                  <td>{new Date(log.logged_at).toLocaleString('th-TH')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}