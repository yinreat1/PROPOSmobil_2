import { useState, useRef, useEffect } from 'react';
import { Camera, X, ScanLine, Check } from 'lucide-react';
import { BrowserMultiFormatReader } from '@zxing/browser';

type Props = { onDetected: (barcode: string) => void; onClose: () => void };
export default function BarcodeScanner({ onDetected, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState('');
  const [scanning, setScanning] = useState(false);
  const [lastScan, setLastScan] = useState('');
  const readerRef = useRef<BrowserMultiFormatReader | null>(null);

  useEffect(() => {
    let mounted = true;
    const reader = new BrowserMultiFormatReader(); readerRef.current = reader;
    async function start() {
      try {
        setScanning(true);
        const devices = await BrowserMultiFormatReader.listVideoInputDevices();
        const deviceId = devices[devices.length - 1]?.deviceId;
        if (!deviceId || !videoRef.current) throw new Error('Kamera bulunamadı.');
        await reader.decodeFromVideoDevice(deviceId, videoRef.current, (result) => {
          if (!mounted || !result) return;
          const code = result.getText().trim(); if (!code) return;
          setLastScan(code); navigator.vibrate?.(80); onDetected(code);
        });
      } catch (e: any) { if (mounted) setError(e?.message || 'Kamera açılamadı. Tarayıcı kamera iznini kontrol edin.'); setScanning(false); }
    }
    start();
    return () => { mounted = false; try { reader.reset(); } catch {} };
  }, [onDetected]);

  return <div className="fixed inset-0 z-[100] flex items-end bg-slate-950/80 sm:items-center sm:justify-center p-3">
    <div className="w-full max-w-lg overflow-hidden rounded-3xl bg-white shadow-2xl">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3"><div className="flex items-center gap-2 font-black"><ScanLine size={19}/> Barkod Tara</div><button onClick={onClose}><X size={22}/></button></div>
      <div className="relative aspect-[4/3] bg-black"><video ref={videoRef} className="h-full w-full object-cover" playsInline muted autoPlay/><div className="pointer-events-none absolute inset-8 rounded-2xl border-2 border-white/80"/></div>
      <div className="p-4">{error?<p className="rounded-xl bg-red-50 p-3 text-sm font-semibold text-red-700">{error}</p>:<p className="flex items-center gap-2 text-sm text-slate-600">{scanning?<><Camera size={17}/> Barkodu çerçevenin içine tutun.</>:<><Check size={17}/> Hazırlanıyor...</>}</p>}{lastScan&&<p className="mt-2 rounded-xl bg-emerald-50 p-3 text-sm font-black text-emerald-700">Bulundu: {lastScan}</p>}</div>
    </div>
  </div>;
}
