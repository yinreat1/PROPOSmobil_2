import { useState, type ReactNode, type FormEvent } from 'react';
import {
  AlertTriangle,
  ArrowDownCircle,
  ArrowUpCircle,
  BarChart3,
  Barcode as BarcodeIcon,
  CheckCircle2,
  ChevronLeft,
  Edit3,
  Home,
  LogOut,
  Package,
  Phone,
  Search,
  Smartphone,
  UserRound,
  Wallet,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import {
  addProduct,
  addStock,
  payCustomerDebt,
  setStock,
  updateProduct,
  useCategories,
  useCustomers,
  useProducts,
  type Customer,
} from '@/lib/hooks';
import { formatCurrency, generateBarcode } from '@/lib/utils';
import type { Product } from '@/lib/supabase';
import BarcodeScanner from '@/components/BarcodeScanner';

type MobileTab = 'home' | 'products' | 'customers' | 'stock' | 'more';

type MobilePageProps = {
  onSwitchToPC?: () => void;
  currentStaff?: { name: string; role: string } | null;
  currentStaffId?: string | null;
  online?: boolean;
  onLogout?: () => void;
};

export default function MobilePage({ onSwitchToPC, currentStaff, currentStaffId, online = true, onLogout }: MobilePageProps) {
  const [tab, setTab] = useState<MobileTab>('home');

  return (
    <div className="mobile-app-shell flex h-screen flex-col overflow-hidden bg-slate-50">
      <MobileTopBar currentStaff={currentStaff} online={online} title="Pro POS Mobil" />
      {!online && <div className="shrink-0 border-b border-amber-200 bg-amber-50 px-4 py-2 text-center text-[11px] font-bold text-amber-800">İnternet bağlantısı yok. Mobil Yönetim yalnızca canlı Supabase verisiyle çalışır; değişiklikler çevrimdışıyken kaydedilmez.</div>}
      <main className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'home' && <MobileHome setTab={setTab} currentStaff={currentStaff} />}
        {tab === 'products' && <MobileProducts />}
        {tab === 'customers' && <MobileCustomers currentStaffId={currentStaffId} />}
        {tab === 'stock' && <MobileStock currentStaffId={currentStaffId} />}
        {tab === 'more' && <MobileMore onSwitchToPC={onSwitchToPC} onLogout={onLogout} />}
      </main>
      <MobileBottomNav tab={tab} setTab={setTab} />
    </div>
  );
}

function MobileTopBar({ currentStaff, online, title }: { currentStaff?: { name: string; role: string } | null; online: boolean; title: string }) {
  return (
    <header className="shrink-0 border-b border-slate-200 bg-white px-4 pb-3 pt-[calc(env(safe-area-inset-top)+10px)] shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-teal-600 text-white"><Smartphone size={20} /></div>
          <div className="min-w-0">
            <h1 className="truncate text-base font-black text-slate-800">{title}</h1>
            <p className="truncate text-[11px] text-slate-500">{currentStaff?.name || 'Personel'} · {roleLabel(currentStaff?.role)}</p>
          </div>
        </div>
        <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-[10px] font-bold ${online ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
          {online ? <Wifi size={12} /> : <WifiOff size={12} />} {online ? 'Online' : 'Çevrimdışı'}
        </span>
      </div>
    </header>
  );
}

function roleLabel(role?: string) {
  if (role === 'admin') return 'Admin';
  if (role === 'manager') return 'Müdür';
  return 'Kasiyer';
}

function MobileBottomNav({ tab, setTab }: { tab: MobileTab; setTab: (tab: MobileTab) => void }) {
  const items = [
    ['home', 'Ana Sayfa', Home],
    ['products', 'Ürünler', Package],
    ['customers', 'Cari', UserRound],
    ['stock', 'Stok', BarChart3],
    ['more', 'Daha', Smartphone],
  ] as const;
  return (
    <nav className="shrink-0 border-t border-slate-200 bg-white px-2 pb-[calc(env(safe-area-inset-bottom)+4px)] pt-1 shadow-[0_-5px_18px_rgba(15,23,42,.07)]">
      <div className="grid grid-cols-5 gap-1">
        {items.map(([key, label, Icon]) => (
          <button key={key} onClick={() => setTab(key)} className={`mobile-touch flex min-h-14 flex-col items-center justify-center rounded-xl text-[10px] font-bold ${tab === key ? 'bg-teal-50 text-teal-700' : 'text-slate-500'}`}>
            <Icon size={19} />
            <span className="mt-1">{label}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}

function MobileHome({ setTab, currentStaff }: { setTab: (tab: MobileTab) => void; currentStaff?: { name: string } | null }) {
  const { products } = useProducts({ remoteOnly: true });
  const { customers } = useCustomers({ remoteOnly: true });
  const lowStock = products.filter((p) => Number(p.stock) <= Number(p.min_stock));
  const totalDebt = customers.reduce((sum, c) => sum + Math.max(0, Number(c.balance || 0)), 0);

  return (
    <div className="p-4 pb-8">
      <div className="rounded-3xl bg-gradient-to-br from-teal-700 to-teal-500 p-5 text-white shadow-lg">
        <p className="text-xs font-semibold text-teal-100">Hoş geldin</p>
        <h2 className="mt-1 text-2xl font-black">{currentStaff?.name || 'Personel'}</h2>
        <p className="mt-2 text-sm text-teal-50">Telefon uygulaması satış yapmak için değil, mağazayı uzaktan hızlı yönetmek için tasarlandı.</p><div className="mt-3 inline-flex items-center gap-2 rounded-full bg-white/15 px-3 py-1.5 text-[11px] font-bold text-white"><span className="h-2 w-2 rounded-full bg-emerald-300" /> Canlı Supabase bağlantısı</div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <StatCard label="Ürün" value={String(products.length)} icon={<Package size={19} />} />
        <StatCard label="Müşteri" value={String(customers.length)} icon={<UserRound size={19} />} />
        <StatCard label="Toplam Cari Borç" value={formatCurrency(totalDebt)} icon={<Wallet size={19} />} danger />
        <StatCard label="Kritik Stok" value={String(lowStock.length)} icon={<AlertTriangle size={19} />} danger={lowStock.length > 0} />
      </div>

      <h3 className="mt-6 mb-3 text-sm font-black text-slate-800">Hızlı İşlemler</h3>
      <div className="grid gap-3">
        <QuickAction icon={<Wallet size={23} />} title="Borç Tahsil Et" description="Müşteriden ödeme al ve cariyi düşür" onClick={() => setTab('customers')} />
        <QuickAction icon={<Package size={23} />} title="Ürünleri Yönet" description="Fiyat, maliyet, barkod ve ürün detaylarını düzenle" onClick={() => setTab('products')} />
        <QuickAction icon={<BarChart3 size={23} />} title="Stok Kontrolü" description="Stokları kontrol et, giriş yap veya düzelt" onClick={() => setTab('stock')} />
      </div>

      {lowStock.length > 0 && (
        <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4">
          <div className="flex items-center gap-2 font-bold text-amber-800"><AlertTriangle size={18} /> Stok uyarısı</div>
          <p className="mt-1 text-xs text-amber-700">{lowStock.slice(0, 4).map((p) => p.name).join(', ')}{lowStock.length > 4 ? ` ve ${lowStock.length - 4} ürün daha` : ''}</p>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, icon, danger = false }: { label: string; value: string; icon: ReactNode; danger?: boolean }) {
  return <div className={`rounded-2xl border p-4 ${danger ? 'border-amber-200 bg-amber-50' : 'border-slate-200 bg-white'}`}><div className={danger ? 'text-amber-700' : 'text-teal-700'}>{icon}</div><p className="mt-2 text-[11px] font-semibold text-slate-500">{label}</p><p className="mt-1 truncate text-lg font-black text-slate-800">{value}</p></div>;
}

function QuickAction({ icon, title, description, onClick }: { icon: ReactNode; title: string; description: string; onClick: () => void }) {
  return <button onClick={onClick} className="mobile-touch flex items-center gap-4 rounded-2xl border border-slate-200 bg-white p-4 text-left shadow-sm"><span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-teal-50 text-teal-700">{icon}</span><span className="min-w-0 flex-1"><b className="block text-sm text-slate-800">{title}</b><small className="mt-1 block text-xs text-slate-500">{description}</small></span><ChevronLeft size={18} className="rotate-180 text-slate-300" /></button>;
}

function MobileProducts() {
  // Mobil uygulama verisi yalnızca Supabase API'den gelir. Offline cache
  // burada bilerek kullanılmaz; böylece telefondaki eski fiyat/stok ile
  // yanlış güncelleme yapılmaz.
  const { products, loading, reload } = useProducts({ remoteOnly: true });
  const { categories } = useCategories({ remoteOnly: true });
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Product | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [scan, setScan] = useState(false);
  const filtered = products.filter((p) => p.name.toLocaleLowerCase('tr-TR').includes(search.toLocaleLowerCase('tr-TR')) || String(p.barcode || '').includes(search));

  return <section className="p-4 pb-8">
    <div className="mb-3 flex items-center justify-between"><div><h2 className="text-xl font-black text-slate-800">Ürünler</h2><p className="text-xs text-slate-500">Detay, fiyat, barkod ve stok bilgisi</p></div><button onClick={() => setShowNew(true)} className="mobile-touch rounded-xl bg-teal-600 px-3 py-2 text-xs font-bold text-white">+ Yeni</button></div>
    <div className="relative"><Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18}/><input className="input pl-10 pr-12 text-base" placeholder="Ürün veya barkod ara..." value={search} onChange={(e)=>setSearch(e.target.value)}/><button onClick={()=>setScan(true)} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg bg-teal-50 p-2 text-teal-700"><BarcodeIcon size={18}/></button></div>
    <div className="mt-3 space-y-2">{loading ? <div className="p-10 text-center text-slate-400">Yükleniyor...</div> : filtered.length === 0 ? <div className="rounded-2xl border border-dashed border-slate-300 p-10 text-center text-slate-400">Ürün bulunamadı.</div> : filtered.map((product)=><button key={product.id} onClick={()=>setEditing(product)} className="mobile-touch flex w-full items-center gap-3 rounded-2xl border border-slate-200 bg-white p-3 text-left shadow-sm"><div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-400"><Package size={21}/></div><div className="min-w-0 flex-1"><p className="truncate text-sm font-bold text-slate-800">{product.name}</p><p className="truncate font-mono text-[11px] text-slate-400">{product.barcode || 'Barkod yok'}</p></div><div className="shrink-0 text-right"><b className="block text-sm text-teal-700">{formatCurrency(product.price)}</b><span className={`text-[11px] font-semibold ${Number(product.stock)<=Number(product.min_stock)?'text-red-600':'text-slate-500'}`}>Stok {product.stock} {product.unit}</span></div></button>)}</div>
    {(editing || showNew) && <MobileProductForm product={editing} categories={categories} onClose={()=>{setEditing(null);setShowNew(false);}} onSaved={reload}/>} 
    {scan && <BarcodeScanner onDetected={(value)=>{setSearch(value);setScan(false);}} onClose={()=>setScan(false)} />}
  </section>;
}

function MobileProductForm({ product, categories, onClose, onSaved }: { product: Product | null; categories: {id:string;name:string}[]; onClose:()=>void; onSaved:()=>Promise<void> }) {
  const [name,setName]=useState(product?.name||'');
  const [barcode,setBarcode]=useState(product?.barcode||'');
  const [price,setPrice]=useState(String(product?.price??''));
  const [cost,setCost]=useState(String(product?.cost??0));
  const [stock,setStock]=useState(String(product?.stock??0));
  const [minStock,setMinStock]=useState(String(product?.min_stock??0));
  const [categoryId,setCategoryId]=useState(product?.category_id||'');
  const [unit,setUnit]=useState(product?.unit||'adet');
  const [saving,setSaving]=useState(false); const [error,setError]=useState(''); const [scan,setScan]=useState(false);
  async function save(e:FormEvent){e.preventDefault(); if(!name.trim()||!price){setError('Ürün adı ve satış fiyatı gerekli.');return;} setSaving(true); setError(''); const payload:any={name:name.trim(),barcode:barcode.trim()||null,price:Number(price),cost:Number(cost)||0,stock:Number(stock)||0,min_stock:Number(minStock)||0,category_id:categoryId||null,unit}; const ok=product?await updateProduct(product.id,payload):Boolean(await addProduct(payload as any)); if(!ok){setError('Ürün kaydedilemedi. Barkodun başka üründe olmadığını kontrol edin.');setSaving(false);return;} await onSaved();setSaving(false);onClose();}
  return <div className="fixed inset-0 z-[80] flex items-end bg-slate-900/50" onClick={onClose}><div className="max-h-[92vh] w-full overflow-y-auto rounded-t-3xl bg-white p-4 pb-8" onClick={(e)=>e.stopPropagation()}><div className="sticky top-0 z-10 -mx-4 mb-4 flex items-center justify-between border-b border-slate-100 bg-white px-4 py-3"><div><h3 className="font-black text-slate-800">{product?'Ürün Düzenle':'Yeni Ürün'}</h3><p className="text-[11px] text-slate-400">Telefon üzerinden temel ürün yönetimi</p></div><button onClick={onClose}><X size={22}/></button></div><form onSubmit={save} className="space-y-3"><label className="block"><span className="label">Ürün Adı</span><input className="input text-base" value={name} onChange={(e)=>setName(e.target.value)} autoFocus/></label><label className="block"><span className="label">Barkod</span><div className="flex gap-2"><input className="input flex-1 font-mono" value={barcode} onChange={(e)=>setBarcode(e.target.value)} /><button type="button" onClick={()=>setBarcode(generateBarcode())} className="btn-secondary px-3"><BarcodeIcon size={17}/></button><button type="button" onClick={()=>setScan(true)} className="btn-primary px-3"><BarcodeIcon size={17}/></button></div></label><div className="grid grid-cols-2 gap-3"><label><span className="label">Satış Fiyatı</span><input type="number" step="0.01" className="input text-base" value={price} onChange={(e)=>setPrice(e.target.value)}/></label><label><span className="label">Alış Fiyatı</span><input type="number" step="0.01" className="input text-base" value={cost} onChange={(e)=>setCost(e.target.value)}/></label></div><div className="grid grid-cols-2 gap-3"><label><span className="label">Stok</span><input type="number" step="0.001" className="input text-base" value={stock} onChange={(e)=>setStock(e.target.value)}/></label><label><span className="label">Min. Stok</span><input type="number" step="0.001" className="input text-base" value={minStock} onChange={(e)=>setMinStock(e.target.value)}/></label></div><div className="grid grid-cols-2 gap-3"><label><span className="label">Kategori</span><select className="input" value={categoryId} onChange={(e)=>setCategoryId(e.target.value)}><option value="">Yok</option>{categories.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label><label><span className="label">Birim</span><select className="input" value={unit} onChange={(e)=>setUnit(e.target.value)}><option value="adet">Adet</option><option value="kg">Kg</option><option value="gr">Gr</option><option value="lt">Litre</option><option value="ml">Ml</option><option value="paket">Paket</option></select></label></div>{error&&<p className="rounded-xl bg-red-50 p-3 text-xs font-semibold text-red-700">{error}</p>}<button disabled={saving} className="btn-primary w-full py-3">{saving?'Kaydediliyor...':product?'Ürünü Güncelle':'Ürünü Kaydet'}</button></form>{scan&&<BarcodeScanner onDetected={(value)=>{setBarcode(value);setScan(false)}} onClose={()=>setScan(false)}/>}</div></div>;
}

function MobileCustomers({ currentStaffId }: { currentStaffId?: string | null }) {
  const { customers, loading, reload } = useCustomers({ remoteOnly: true });
  const [search,setSearch]=useState(''); const [selected,setSelected]=useState<Customer|null>(null);
  const filtered=customers.filter(c=>c.name.toLocaleLowerCase('tr-TR').includes(search.toLocaleLowerCase('tr-TR')) || String(c.phone||'').includes(search));
  return <section className="p-4 pb-8"><div className="mb-3"><h2 className="text-xl font-black text-slate-800">Müşteriler & Cari</h2><p className="text-xs text-slate-500">Borç görüntüle ve ödeme al</p></div><div className="relative"><Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18}/><input className="input pl-10 text-base" placeholder="Müşteri veya telefon ara..." value={search} onChange={e=>setSearch(e.target.value)}/></div><div className="mt-3 space-y-2">{loading?<div className="p-10 text-center text-slate-400">Yükleniyor...</div>:filtered.map(c=><button key={c.id} onClick={()=>setSelected(c)} className="mobile-touch flex w-full items-center gap-3 rounded-2xl border border-slate-200 bg-white p-4 text-left shadow-sm"><span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-teal-50 text-teal-700"><UserRound size={20}/></span><span className="min-w-0 flex-1"><b className="block truncate text-sm text-slate-800">{c.name}</b><small className="mt-1 block truncate text-xs text-slate-400">{c.phone||'Telefon yok'}</small></span><span className="text-right"><b className={`block text-sm ${Number(c.balance)>0?'text-red-600':'text-emerald-600'}`}>{formatCurrency(c.balance)}</b><small className="text-[10px] text-slate-400">{Number(c.balance)>0?'Borç':'Bakiye yok'}</small></span></button>)}</div>{selected&&<DebtPaymentModal customer={selected} staffId={currentStaffId} onClose={()=>setSelected(null)} onSaved={async()=>{setSelected(null);await reload();}}/>}</section>;
}

function DebtPaymentModal({ customer, staffId, onClose, onSaved }: { customer: Customer; staffId?: string|null; onClose:()=>void; onSaved:()=>Promise<void> }) {
  const [amount,setAmount]=useState(String(Math.max(0,Number(customer.balance||0)))); const [note,setNote]=useState(''); const [saving,setSaving]=useState(false); const [error,setError]=useState(''); const balance=Number(customer.balance||0);
  async function pay(){const value=Math.min(balance,Number(amount)); if(!Number.isFinite(value)||value<=0){setError('Geçerli bir ödeme tutarı girin.');return;} setSaving(true);const result=await payCustomerDebt(customer.id,value,note,staffId||undefined);setSaving(false);if(!result.success){setError('Tahsilat yapılamadı.');return;}await onSaved();}
  return <div className="fixed inset-0 z-[80] flex items-end bg-slate-900/50" onClick={onClose}><div className="w-full rounded-t-3xl bg-white p-5 pb-8" onClick={e=>e.stopPropagation()}><div className="flex items-start justify-between"><div><p className="text-xs font-semibold text-slate-400">Cari Tahsilat</p><h3 className="mt-1 text-xl font-black text-slate-800">{customer.name}</h3><p className="mt-1 text-sm font-bold text-red-600">Mevcut borç: {formatCurrency(balance)}</p></div><button onClick={onClose}><X size={22}/></button></div>{customer.phone&&<a href={`tel:${customer.phone}`} className="mt-4 flex items-center gap-2 text-sm font-semibold text-teal-700"><Phone size={16}/> {customer.phone}</a>}<label className="mt-4 block"><span className="label">Tahsilat Tutarı</span><input autoFocus type="number" step="0.01" min="0" max={balance} className="input text-2xl font-black" value={amount} onChange={e=>setAmount(e.target.value)}/></label><label className="mt-3 block"><span className="label">Not</span><input className="input" value={note} onChange={e=>setNote(e.target.value)} placeholder="İsteğe bağlı"/></label>{error&&<p className="mt-3 rounded-xl bg-red-50 p-3 text-xs font-semibold text-red-700">{error}</p>}<button disabled={saving} onClick={pay} className="btn-primary mt-4 flex w-full items-center justify-center gap-2 py-3">{saving?'Kaydediliyor...':<><CheckCircle2 size={18}/> Tahsilatı Kaydet</>}</button></div></div>;
}

function MobileStock({ currentStaffId }: { currentStaffId?: string | null }) {
  const { products, loading, reload } = useProducts({ remoteOnly: true });
  const [search,setSearch]=useState(''); const [selected,setSelected]=useState<Product|null>(null);
  const low=products.filter(p=>Number(p.stock)<=Number(p.min_stock));
  const filtered=products.filter(p=>p.name.toLocaleLowerCase('tr-TR').includes(search.toLocaleLowerCase('tr-TR'))||String(p.barcode||'').includes(search));
  return <section className="p-4 pb-8"><div className="mb-3"><h2 className="text-xl font-black text-slate-800">Stok Kontrolü</h2><p className="text-xs text-slate-500">Stok ekle veya mevcut stoğu düzelt</p></div>{low.length>0&&<div className="mb-3 rounded-2xl border border-red-200 bg-red-50 p-3 text-xs font-semibold text-red-700"><AlertTriangle size={16} className="mr-1 inline"/>{low.length} üründe stok kritik seviyede.</div>}<div className="relative"><Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18}/><input className="input pl-10 text-base" placeholder="Stok ürünü ara..." value={search} onChange={e=>setSearch(e.target.value)}/></div><div className="mt-3 space-y-2">{loading?<div className="p-10 text-center text-slate-400">Yükleniyor...</div>:filtered.map(p=><button key={p.id} onClick={()=>setSelected(p)} className="mobile-touch flex w-full items-center gap-3 rounded-2xl border border-slate-200 bg-white p-4 text-left shadow-sm"><span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${Number(p.stock)<=Number(p.min_stock)?'bg-red-50 text-red-600':'bg-emerald-50 text-emerald-600'}`}><Package size={20}/></span><span className="min-w-0 flex-1"><b className="block truncate text-sm text-slate-800">{p.name}</b><small className="block text-xs text-slate-400">Min. {p.min_stock} {p.unit}</small></span><span className="text-right"><b className={`block text-lg ${Number(p.stock)<=Number(p.min_stock)?'text-red-600':'text-slate-800'}`}>{p.stock}</b><small className="text-[10px] text-slate-400">{p.unit}</small></span></button>)}</div>{selected&&<StockModal product={selected} staffId={currentStaffId} onClose={()=>setSelected(null)} onSaved={async()=>{setSelected(null);await reload();}}/>}</section>;
}

function StockModal({ product, staffId, onClose, onSaved }: { product: Product; staffId?: string | null; onClose:()=>void; onSaved:()=>Promise<void> }) {
  const [mode,setMode]=useState<'in'|'set'>('in'); const [qty,setQty]=useState(''); const [reason,setReason]=useState(mode==='in'?'Stok girişi':'Stok düzeltme'); const [saving,setSaving]=useState(false); const [error,setError]=useState('');
  async function save(){const n=Number(qty);if(!Number.isFinite(n)||n<0||(mode==='in'&&n<=0)){setError('Geçerli miktar girin.');return;}setSaving(true);const ok=mode==='in'?await addStock(product,n,reason,staffId||undefined):await setStock(product,n,reason,staffId||undefined);setSaving(false);if(!ok){setError('Stok güncellenemedi.');return;}await onSaved();}
  return <div className="fixed inset-0 z-[80] flex items-end bg-slate-900/50" onClick={onClose}><div className="w-full rounded-t-3xl bg-white p-5 pb-8" onClick={e=>e.stopPropagation()}><div className="flex items-start justify-between"><div><p className="text-xs text-slate-400">Stok işlemi</p><h3 className="mt-1 text-lg font-black text-slate-800">{product.name}</h3><p className="mt-1 text-sm text-slate-500">Mevcut: <b>{product.stock} {product.unit}</b></p></div><button onClick={onClose}><X size={22}/></button></div><div className="mt-4 grid grid-cols-2 gap-2"><button onClick={()=>{setMode('in');setReason('Stok girişi')}} className={`rounded-xl py-3 text-sm font-bold ${mode==='in'?'bg-emerald-600 text-white':'bg-slate-100 text-slate-600'}`}><ArrowDownCircle size={17} className="mr-1 inline"/> Stok Ekle</button><button onClick={()=>{setMode('set');setReason('Stok düzeltme')}} className={`rounded-xl py-3 text-sm font-bold ${mode==='set'?'bg-blue-600 text-white':'bg-slate-100 text-slate-600'}`}><ArrowUpCircle size={17} className="mr-1 inline"/> Düzelt</button></div><label className="mt-4 block"><span className="label">{mode==='in'?'Eklenecek miktar':'Yeni stok miktarı'}</span><input autoFocus type="number" step="0.001" min="0" className="input text-2xl font-black" value={qty} onChange={e=>setQty(e.target.value)}/></label><label className="mt-3 block"><span className="label">Açıklama</span><input className="input" value={reason} onChange={e=>setReason(e.target.value)}/></label>{error&&<p className="mt-3 rounded-xl bg-red-50 p-3 text-xs font-semibold text-red-700">{error}</p>}<button disabled={saving} onClick={save} className="btn-primary mt-4 w-full py-3">{saving?'Kaydediliyor...':'Stok Kaydet'}</button></div></div>;
}

function MobileMore({ onSwitchToPC, onLogout }: { onSwitchToPC?:()=>void; onLogout?:()=>void }) {
  return <section className="p-4 pb-8"><div className="rounded-3xl border border-slate-200 bg-white p-5"><div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-teal-50 text-teal-700"><Smartphone size={24}/></div><h2 className="mt-3 text-xl font-black text-slate-800">Mobil Yönetim</h2><p className="mt-1 text-sm text-slate-500">Telefon uygulaması satış ekranını bilerek içermez. Ana amaç hızlı cari, stok ve ürün yönetimidir.</p></div>{onSwitchToPC&&<button onClick={onSwitchToPC} className="mobile-touch mt-4 flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white text-sm font-bold text-slate-700"><Home size={17}/> PC Moduna Geç</button>}{onLogout&&<button onClick={onLogout} className="mobile-touch mt-3 flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-slate-900 text-sm font-bold text-white"><LogOut size={17}/> Personel Değiştir / Çıkış</button>}<div className="mt-4 rounded-2xl bg-slate-100 p-4 text-xs leading-5 text-slate-600"><b>Mobilde bulunanlar:</b> müşteri borç tahsilatı, ürün detayları ve düzenleme, barkodla ürün bulma, stok kontrolü, stok giriş/düzeltme ve düşük stok uyarıları.</div></section>;
}
