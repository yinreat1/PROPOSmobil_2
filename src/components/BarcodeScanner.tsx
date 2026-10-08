import { useEffect, useRef, useState } from 'react';
import { Camera, X, ScanLine, Check, ShieldAlert } from 'lucide-react';
import { BrowserMultiFormatReader } from '@zxing/browser';

type Props = { onDetected: (barcode: string) => void; onClose: () => void };

export default function BarcodeScanner({ onDetected, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const readerRef = useRef<BrowserMultiFormatReader | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const mountedRef = useRef(true);
  const detectedRef = useRef(false);

  const [error, setError] = useState('');
  const [scanning, setScanning] = useState(false);
  const [lastScan, setLastScan] = useState('');

  useEffect(() => {
    mountedRef.current = true;
    detectedRef.current = false;

    const reader = new BrowserMultiFormatReader();
    readerRef.current = reader;

    const stopCamera = () => {
      try { reader.reset(); } catch {}
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }
      if (videoRef.current) videoRef.current.srcObject = null;
    };

    async function start() {
      try {
        setError('');
        setScanning(false);

        if (!window.isSecureContext) {
          throw new Error('Kamera için güvenli bağlantı gerekir. Vercel adresinin HTTPS olduğundan emin olun.');
        }

        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error('Bu tarayıcı kamera erişimini desteklemiyor. Chrome veya Safari ile tekrar deneyin.');
        }

        // ÖNEMLİ: Önce kamera iznini tetikle.
        // Eski kod listVideoInputDevices() çağrısını izinden önce yapıyordu;
        // bazı Android/iOS tarayıcılarında bu aşamada cihaz listesi boş dönüyordu.
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 720 }
          },
          audio: false
        });

        if (!mountedRef.current) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        streamRef.current = stream;

        const video = videoRef.current;
        if (!video) throw new Error('Kamera görüntüsü başlatılamadı.');

        video.srcObject = stream;
        video.muted = true;
        video.playsInline = true;
        await video.play();

        setScanning(true);

        // İzin verildikten sonra cihazları listele; artık bazı mobil
        // tarayıcıların daha önce gizlediği kamera cihazları görünür.
        const devices = await BrowserMultiFormatReader.listVideoInputDevices().catch(() => []);
        const deviceId =
          devices.find((d) => /back|rear|environment|arka/i.test(d.label))?.deviceId ||
          devices[devices.length - 1]?.deviceId;

        // ZXing kendi stream'ini açabiliyorsa kullan. Aksi durumda mevcut
        // getUserMedia stream'i video üzerinde çalışmaya devam eder.
        if (deviceId) {
          try {
            await reader.decodeFromVideoDevice(deviceId, video, (result) => {
              if (!mountedRef.current || detectedRef.current || !result) return;
              const code = result.getText().trim();
              if (!code) return;

              detectedRef.current = true;
              setLastScan(code);
              navigator.vibrate?.(80);
              onDetected(code);
            });
            return;
          } catch {
            // Mevcut getUserMedia görüntüsünü kullanmaya devam et.
          }
        }

        throw new Error('Kamera açıldı fakat barkod tarayıcı başlatılamadı.');
      } catch (e: any) {
        if (!mountedRef.current) return;

        const name = e?.name || '';
        let message = e?.message || 'Kamera açılamadı.';

        if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
          message = 'Kamera izni verilmedi. Tarayıcı ayarlarından bu site için Kamera iznini Açın ve tekrar deneyin.';
        } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
          message = 'Bu telefonda kullanılabilir kamera bulunamadı.';
        } else if (name === 'NotReadableError' || name === 'TrackStartError') {
          message = 'Kamera başka bir uygulama tarafından kullanılıyor. Diğer kamera uygulamasını kapatıp tekrar deneyin.';
        }

        setError(message);
        setScanning(false);
        stopCamera();
      }
    }

    start();

    return () => {
      mountedRef.current = false;
      stopCamera();
    };
  }, [onDetected]);

  return (
    <div className="fixed inset-0 z-[100] flex items-end bg-slate-950/80 p-3 sm:items-center sm:justify-center">
      <div className="w-full max-w-lg overflow-hidden rounded-3xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <div className="flex items-center gap-2 font-black"><ScanLine size={19}/> Barkod Tara</div>
          <button onClick={onClose} aria-label="Kapat"><X size={22}/></button>
        </div>

        <div className="relative aspect-[4/3] bg-black">
          <video
            ref={videoRef}
            className="h-full w-full object-cover"
            playsInline
            muted
            autoPlay
            webkit-playsinline="true"
          />
          <div className="pointer-events-none absolute inset-8 rounded-2xl border-2 border-white/80" />
          {!scanning && !error && (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="rounded-2xl bg-black/60 px-4 py-3 text-sm font-bold text-white">
                Kamera izni bekleniyor...
              </div>
            </div>
          )}
        </div>

        <div className="p-4">
          {error ? (
            <div className="rounded-xl bg-red-50 p-3 text-sm font-semibold text-red-700">
              <div className="flex items-start gap-2">
                <ShieldAlert size={18} className="mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
              <p className="mt-2 text-xs font-medium text-red-600">
                Android: adres çubuğundaki kilit simgesi → İzinler → Kamera → İzin ver.
              </p>
            </div>
          ) : (
            <p className="flex items-center gap-2 text-sm text-slate-600">
              {scanning ? <><Camera size={17}/> Barkodu çerçevenin içine tutun.</> : <>Kamera hazırlanıyor...</>}
            </p>
          )}

          {lastScan && (
            <p className="mt-2 rounded-xl bg-emerald-50 p-3 text-sm font-black text-emerald-700">
              <Check size={17} className="mr-1 inline" /> Bulundu: {lastScan}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
