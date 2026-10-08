import { useEffect, useMemo, useState } from 'react';
import { LogIn, Store } from 'lucide-react';
import MobilePage from '@/pages/MobilePage';
import { supabase } from '@/lib/supabase';
import type { Staff } from '@/lib/supabase';

const SESSION_KEY = 'propos-current-staff-v2';

function readSession(): Staff | null {
  try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; }
}
function writeSession(staff: Staff | null) {
  try { if (staff) sessionStorage.setItem(SESSION_KEY, JSON.stringify(staff)); else sessionStorage.removeItem(SESSION_KEY); } catch {}
}
function roleLabel(role: Staff['role']) { return role === 'admin' ? 'Admin' : role === 'manager' ? 'Müdür' : 'Kasiyer'; }

function StaffLogin({ staff, onLogin }: { staff: Staff[]; onLogin: (staff: Staff) => void }) {
  const [selected, setSelected] = useState(staff[0]?.id || '');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const current = staff.find(s => s.id === selected);
  useEffect(() => { if (!staff.some(s => s.id === selected)) setSelected(staff[0]?.id || ''); }, [staff, selected]);

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError('');
    if (!current) return;
    if (!current.pin_hash && !current.pin) { onLogin(current); return; }
    const { data, error: rpcError } = await supabase.rpc('verify_staff_pin', { p_staff_id: current.id, p_pin: pin.trim() });
    if (rpcError || data !== true) { setError('PIN hatalı.'); return; }
    onLogin(current);
  }

  return <div className="fixed inset-0 flex items-center justify-center bg-slate-900 p-4">
    <form onSubmit={submit} className="w-full max-w-md rounded-3xl bg-white p-7 shadow-2xl">
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-teal-600 text-white"><Store size={28}/></div>
      <h1 className="mt-4 text-center text-2xl font-black text-slate-800">Pro POS Mobil</h1>
      <p className="mt-1 text-center text-sm text-slate-500">Yönetim uygulamasına giriş yapın.</p>
      <div className="mt-6 space-y-3">
        <select className="input text-base" value={selected} onChange={e=>{setSelected(e.target.value);setPin('');}}>
          {staff.map(s=><option key={s.id} value={s.id}>{s.name} — {roleLabel(s.role)}</option>)}
        </select>
        {(current?.pin_hash || current?.pin) && <input className="input text-lg" autoFocus type="password" inputMode="numeric" placeholder="PIN" value={pin} onChange={e=>setPin(e.target.value)} maxLength={8}/>} 
        {error && <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">{error}</div>}
        <button className="btn-primary w-full py-3.5 text-base" type="submit"><LogIn size={18}/> Giriş Yap</button>
      </div>
    </form>
  </div>;
}

export default function App() {
  const [staff, setStaff] = useState<Staff[]>([]);
  const [loadingStaff, setLoadingStaff] = useState(true);
  const [staffError, setStaffError] = useState('');
  const activeStaff = useMemo(() => staff.filter(s => s.active), [staff]);
  const [currentStaff, setCurrentStaff] = useState<Staff | null>(() => readSession());
  const [online, setOnline] = useState(navigator.onLine);

  async function loadStaff() {
    setLoadingStaff(true); setStaffError('');
    const { data, error } = await supabase.from('staff').select('*').eq('active', true).order('name');
    if (error) { setStaffError(error.message || 'Personeller yüklenemedi.'); setStaff([]); setLoadingStaff(false); return; }
    setStaff((data || []) as Staff[]);
    setLoadingStaff(false);
  }
  useEffect(() => { void loadStaff(); const fn=()=>setOnline(navigator.onLine); window.addEventListener('online',fn); window.addEventListener('offline',fn); return()=>{window.removeEventListener('online',fn);window.removeEventListener('offline',fn)}; }, []);
  useEffect(() => {
    if (!currentStaff) return;
    const fresh = activeStaff.find(s => s.id === currentStaff.id);
    if (fresh) { setCurrentStaff(fresh); writeSession(fresh); } else if (!loadingStaff) { setCurrentStaff(null); writeSession(null); }
  }, [activeStaff, loadingStaff]);

  if (loadingStaff) return <div className="fixed inset-0 flex items-center justify-center bg-slate-900 text-white"><div className="text-center"><div className="mx-auto h-10 w-10 animate-spin rounded-full border-4 border-white/30 border-t-white"/><p className="mt-3 text-sm font-semibold">Supabase bağlantısı kontrol ediliyor...</p></div></div>;
  if (staffError) return <div className="fixed inset-0 flex items-center justify-center bg-slate-900 p-5 text-white"><div className="w-full max-w-md rounded-3xl bg-white p-6 text-slate-800"><h1 className="text-xl font-black">Bağlantı kurulamadı</h1><p className="mt-2 text-sm text-slate-500">Mobil uygulama yalnızca canlı Supabase verisiyle çalışır.</p><pre className="mt-3 max-h-32 overflow-auto rounded-xl bg-slate-100 p-3 text-xs">{staffError}</pre><button className="btn-primary mt-4 w-full py-3" onClick={()=>void loadStaff()}>Tekrar Dene</button></div></div>;
  if (!activeStaff.length) return <div className="fixed inset-0 flex items-center justify-center bg-slate-900 p-5 text-white"><div className="rounded-3xl bg-white p-6 text-center text-slate-800"><h1 className="text-xl font-black">Aktif personel bulunamadı</h1><p className="mt-2 text-sm text-slate-500">Önce Pro POS PC sürümünden aktif bir personel oluşturun.</p></div></div>;
  if (!currentStaff) return <StaffLogin staff={activeStaff} onLogin={s=>{writeSession(s);setCurrentStaff(s);}}/>;
  return <MobilePage currentStaff={currentStaff} currentStaffId={currentStaff.id} online={online} onLogout={()=>{writeSession(null);setCurrentStaff(null);}}/>;
}
