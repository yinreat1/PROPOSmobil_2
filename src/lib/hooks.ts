import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import type { Category, Product, Sale, SaleItem, SaleWithItems, Customer, CustomerPayment, CashSession, SalePayment, StockMovement, Staff, StaffEarning, StaffConsumption, StaffPayout, Supplier, PurchaseReceipt, PurchaseReceiptItem } from '@/lib/supabase';
import { getEffectivePrice } from '@/lib/utils';
import { campaignUnitPrice } from '@/lib/campaigns';

async function writeAudit(action: string, entityType: string, entityId?: string, details: Record<string, unknown> = {}) {
  try {
    let staffId: string | null = null;
    let staffName: string | null = null;

    // Resolve the actual Supabase staff row from the active account.
    // Older builds could keep a local/demo id in sessionStorage, which caused
    // audit entries to be saved without an actor even though the sale itself
    // had the correct staff_id.
    try {
      const raw = sessionStorage.getItem('propos-current-staff-v2');
      const saved = raw ? JSON.parse(raw) as { id?: string; name?: string } : null;
      staffId = saved?.id || null;
      staffName = saved?.name || null;

      if (staffId) {
        const byId = await supabase.from('staff').select('id,name,active').eq('id', staffId).eq('active', true).maybeSingle();
        if (!byId.data) staffId = null;
      }
      if (!staffId && staffName) {
        const byName = await supabase.from('staff').select('id,name,active').eq('active', true).ilike('name', staffName).limit(1).maybeSingle();
        staffId = byName.data?.id || null;
        staffName = byName.data?.name || staffName;
      }
    } catch {}

    // As a second safeguard, inherit the real actor from the entity itself.
    // Sales, returns and purchase receipts already persist their staff_id.
    if (!staffId && entityId) {
      try {
        if (entityType === 'sale') {
          const { data } = await supabase.from('sales').select('staff_id').eq('id', entityId).maybeSingle();
          staffId = data?.staff_id || null;
        } else if (entityType === 'purchase_receipt') {
          const { data } = await supabase.from('purchase_receipts').select('staff_id').eq('id', entityId).maybeSingle();
          staffId = data?.staff_id || null;
        }
      } catch {}
    }

    const enrichedDetails = staffName && !details.staff_name
      ? { ...details, staff_name: staffName }
      : details;

    await supabase.from('audit_logs').insert({
      action,
      entity_type: entityType,
      entity_id: entityId || null,
      details: enrichedDetails,
      staff_id: staffId,
    });
  } catch {
    // Audit is best-effort and must never block a POS operation.
  }
}


// ===== 4.6 Offline POS cache =====
const OFFLINE_PRODUCTS_KEY = 'propos-offline-products-v1';
const OFFLINE_CATEGORIES_KEY = 'propos-offline-categories-v1';
const OFFLINE_CUSTOMERS_KEY = 'propos-offline-customers-v1';
export const OFFLINE_SYNC_EVENT = 'propos-offline-sync';

function readOfflineCache<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch { return []; }
}
function writeOfflineCache<T>(key: string, value: T[]) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}
export function getOfflineProducts() { return readOfflineCache<Product>(OFFLINE_PRODUCTS_KEY); }
export function getOfflineCategories() { return readOfflineCache<Category>(OFFLINE_CATEGORIES_KEY); }
export function getOfflineCustomers() { return readOfflineCache<Customer>(OFFLINE_CUSTOMERS_KEY); }

function notifyOfflineSync() {
  try { window.dispatchEvent(new CustomEvent(OFFLINE_SYNC_EVENT)); } catch {}
}

export function useCategories(options?: { remoteOnly?: boolean }) {
  const remoteOnly = Boolean(options?.remoteOnly);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const cached = getOfflineCategories();
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      if (remoteOnly) { setCategories([]); setLoading(false); return; }
      setCategories(cached);
      setLoading(false);
      return;
    }
    setLoading(true);
    const { data, error } = await supabase
      .from('categories')
      .select('*')
      .order('sort_order', { ascending: true });
    if (error) {
      console.error('Kategoriler yüklenemedi:', error);
      if (!remoteOnly && cached.length) setCategories(cached);
      else setCategories([]);
    } else {
      setCategories(data || []);
      writeOfflineCache(OFFLINE_CATEGORIES_KEY, data || []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    const channel = supabase
      .channel('categories-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'categories' }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [load]);

  return { categories, loading, reload: load };
}

export function useProducts(options?: { remoteOnly?: boolean }) {
  const remoteOnly = Boolean(options?.remoteOnly);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const cached = getOfflineProducts();
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      if (remoteOnly) { setProducts([]); setLoading(false); return; }
      setProducts(cached);
      setLoading(false);
      return;
    }
    setLoading(true);
    // deleted_at migration henüz Supabase'de çalıştırılmadıysa ürünleri göstermeyi
    // durdurma. Önce çöp kutusu filtresiyle dene, kolon yoksa eski sorguya geri dön.
    let { data, error } = await supabase
      .from('products')
      .select('*')
      .is('deleted_at', null)
      .order('name', { ascending: true });

    if (error) {
      const message = `${error.message || ''} ${error.code || ''}`.toLowerCase();
      const missingDeletedAt = message.includes('deleted_at') || message.includes('42703') || message.includes('schema cache');
      if (missingDeletedAt) {
        const fallback = await supabase
          .from('products')
          .select('*')
          .order('name', { ascending: true });
        data = fallback.data;
        error = fallback.error;
      }
    }

    if (error) {
      console.error('Ürünler yüklenemedi:', error);
      if (!remoteOnly) {
        const cached = getOfflineProducts();
        if (cached.length) {
          setProducts(cached);
          setLoading(false);
          return;
        }
      }
    } else {
      writeOfflineCache(OFFLINE_PRODUCTS_KEY, data || []);
    }
    setProducts(data || (remoteOnly ? [] : getOfflineProducts()));
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    const channel = supabase
      .channel('products-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'products' }, () => load())
      .subscribe();
    const onOfflineChange = () => {
      if (!navigator.onLine) setProducts(getOfflineProducts());
    };
    window.addEventListener(OFFLINE_SYNC_EVENT, onOfflineChange);
    return () => {
      supabase.removeChannel(channel);
      window.removeEventListener(OFFLINE_SYNC_EVENT, onOfflineChange);
    };
  }, [load]);

  return { products, loading, reload: load };
}

export async function addCategory(name: string): Promise<Category | null> {
  const { data, error } = await supabase
    .from('categories')
    .insert({ name })
    .select()
    .single();
  if (error) {
    console.error('Kategori eklenemedi:', error);
    return null;
  }
  await writeAudit('category_created', 'category', data.id, { name });
  return data;
}

export async function updateCategory(id: string, name: string): Promise<boolean> {
  const { error } = await supabase
    .from('categories')
    .update({ name })
    .eq('id', id);
  if (error) {
    console.error('Kategori güncellenemedi:', error);
    return false;
  }
  await writeAudit('category_updated', 'category', id, { name });
  return true;
}

export async function deleteCategory(id: string): Promise<boolean> {
  const { error } = await supabase
    .from('categories')
    .delete()
    .eq('id', id);
  if (error) {
    console.error('Kategori silinemedi:', error);
    return false;
  }
  await writeAudit('category_deleted', 'category', id);
  return true;
}

export async function addProduct(p: Omit<Product, 'id' | 'created_at' | 'updated_at' | 'deleted_at'>): Promise<Product | null> {
  const payload = { discount_enabled: false, discount_price: null, discount_starts_at: null, discount_ends_at: null, min_stock: 0, additional_barcodes: [], ...p };
  let result = await supabase.from('products').insert(payload).select().single();
  if (result.error && /additional_barcodes|discount_enabled|discount_price|discount_starts_at|discount_ends_at|min_stock|deleted_at|schema cache|column/i.test(result.error.message || '')) {
    const legacy = {
      name: p.name, barcode: p.barcode || null, price: p.price, cost: p.cost, stock: p.stock,
      category_id: p.category_id ?? null, unit: p.unit || 'adet'
    };
    result = await supabase.from('products').insert(legacy).select().single();
  }
  if (result.error) {
    console.error('Ürün eklenemedi:', result.error);
    return null;
  }
  const created = result.data as Product;
  await writeAudit('product_created', 'product', created.id, { name: created.name, price: created.price });
  return created;
}

export async function updateProduct(id: string, p: Partial<Omit<Product, 'id' | 'created_at' | 'updated_at' | 'deleted_at'>>): Promise<boolean> {
  const before = await supabase.from('products').select('price,cost').eq('id',id).maybeSingle();
  // select + single is intentional: an UPDATE with zero affected rows can
  // otherwise look successful when RLS/business scoping rejects the row.
  let result = await supabase.from('products').update(p).eq('id', id).select('*').single();
  if (result.error && /additional_barcodes|discount_enabled|discount_price|discount_starts_at|discount_ends_at|min_stock|deleted_at|schema cache|column/i.test(result.error.message || '')) {
    const legacyKeys = new Set(['name','barcode','price','cost','stock','category_id','unit']);
    const legacy:any = {};
    Object.entries(p).forEach(([k,v]) => { if (legacyKeys.has(k)) legacy[k]=v; });
    result = await supabase.from('products').update(legacy).eq('id', id).select('*').single();
  }
  if (result.error || !result.data) {
    const err = result.error;
    if (err?.code === '23505' || /duplicate key|unique constraint/i.test(err?.message || '')) {
      console.error('Ürün güncellenemedi: barkod zaten kayıtlı.', err);
    } else {
      console.error('Ürün güncellenemedi:', err);
    }
    return false;
  }
  if (before.data && (p.price !== undefined || p.cost !== undefined)) {
    const oldPrice=Number(before.data.price||0), oldCost=Number(before.data.cost||0);
    const newPrice=p.price!==undefined?Number(p.price):oldPrice, newCost=p.cost!==undefined?Number(p.cost):oldCost;
    if (oldPrice!==newPrice || oldCost!==newCost) {
      await supabase.from('product_price_history').insert({product_id:id,old_price:oldPrice,new_price:newPrice,old_cost:oldCost,new_cost:newCost});
    }
  }
  await writeAudit('product_updated', 'product', id, { fields: Object.keys(p) });
  return true;
}

export async function deleteProduct(id: string): Promise<boolean> {
  // Önce çöp kutusuna taşı; kolon/migration yoksa gerçek silmeye geri dön.
  const { error } = await supabase.from('products').update({ deleted_at: new Date().toISOString() }).eq('id', id);
  if (!error) { await writeAudit('product_deleted', 'product', id); return true; }
  const msg = `${error.message || ''} ${error.code || ''}`.toLowerCase();
  const missingDeletedAt = msg.includes('deleted_at') || msg.includes('schema cache') || msg.includes('42703');
  if (missingDeletedAt) {
    const hard = await supabase.from('products').delete().eq('id', id);
    if (!hard.error) { await writeAudit('product_hard_deleted', 'product', id); return true; }
    console.error('Ürün fiziksel olarak da silinemedi:', hard.error);
  } else console.error('Ürün çöp kutusuna taşınamadı:', error);
  return false;
}

export async function restoreProduct(id: string): Promise<boolean> {
  const { error } = await supabase.from('products').update({ deleted_at: null }).eq('id', id);
  if (error) { console.error('Ürün geri yüklenemedi:', error); return false; }
  await writeAudit('product_restored', 'product', id);
  return true;
}

export function useDeletedProducts(limit = 200) {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    // Çöp kutusundaki ürünleri 3 gün sonunda fiziksel olarak temizle.
    // Geçmiş satış/stock kayıtları ürüne bağlıysa DB fonksiyonu o ürünü korur.
    await supabase.rpc('purge_deleted_products').catch((err) => console.warn('Çöp kutusu temizliği atlandı:', err));
    const { data, error } = await supabase
      .from('products')
      .select('*')
      .not('deleted_at', 'is', null)
      .order('deleted_at', { ascending: false })
      .limit(limit);
    if (error) console.error('Ürün çöp kutusu yüklenemedi:', error);
    setProducts(data || []);
    setLoading(false);
  }, [limit]);

  useEffect(() => {
    load();
    const channel = supabase
      .channel('deleted-products-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'products' }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [load]);

  return { products, loading, reload: load };
}

export type CartItem = {
  product: Product;
  quantity: number;
  discountPercent?: number;
  fixedUnitPrice?: number;
};

export type PaymentSplit = { method: 'cash'|'card'|'credit'; amount: number; customerId?: string; customerName?: string };

function cartUnitPrice(item: CartItem) {
  const effective = item.fixedUnitPrice != null ? Number(item.fixedUnitPrice) : campaignUnitPrice(item.product, Number(item.quantity || 1)).price;
  const pct = item.fixedUnitPrice != null ? 0 : Math.max(0, Math.min(100, Number(item.discountPercent || 0)));
  return +(effective * (1 - pct / 100)).toFixed(2);
}


async function recordImmediateStaffEarning(params: {
  saleId: string;
  amountPaid: number;
  currentStaffId: string;
  currentStaffName: string;
}) {
  const { saleId, amountPaid, currentStaffId, currentStaffName } = params;
  if (amountPaid <= 0 || (!currentStaffId && !currentStaffName)) return;

  let resolvedStaff: { id: string; earning_rate: number } | null = null;
  if (currentStaffId) {
    const { data } = await supabase
      .from('staff')
      .select('id,earning_rate')
      .eq('id', currentStaffId)
      .eq('active', true)
      .maybeSingle();
    resolvedStaff = data || null;
  }
  if (!resolvedStaff && currentStaffName) {
    const { data } = await supabase
      .from('staff')
      .select('id,earning_rate,name')
      .eq('active', true)
      .ilike('name', currentStaffName)
      .limit(1);
    resolvedStaff = data?.[0] || null;
  }
  if (!resolvedStaff) return;

  const rate = Math.max(0, Math.min(100, Number(resolvedStaff.earning_rate || 0)));
  if (rate <= 0) return;
  const earningAmount = +(amountPaid * rate / 100).toFixed(2);
  const { data: saleMeta } = await supabase
    .from('sales')
    .select('business_id')
    .eq('id', saleId)
    .maybeSingle();

  const { error: earningError } = await supabase.from('staff_earnings').upsert({
    business_id: saleMeta?.business_id || null,
    staff_id: resolvedStaff.id,
    sale_id: saleId,
    amount_paid: amountPaid,
    rate_percent: rate,
    earning_amount: earningAmount,
    source: 'sale_payment',
  }, { onConflict: 'sale_id' });
  if (earningError) {
    console.warn('Satış çalışan kazancı kaydedilemedi:', earningError);
    return;
  }

  const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Istanbul' });
  const { data: existingDay } = await supabase
    .from('staff_daily_earnings')
    .select('amount_paid,earning_amount,payment_count,business_id')
    .eq('staff_id', resolvedStaff.id)
    .eq('earning_date', day)
    .maybeSingle();

  await supabase.from('staff_daily_earnings').upsert({
    business_id: saleMeta?.business_id || existingDay?.business_id || null,
    staff_id: resolvedStaff.id,
    earning_date: day,
    amount_paid: Number(existingDay?.amount_paid || 0) + amountPaid,
    earning_amount: Number(existingDay?.earning_amount || 0) + earningAmount,
    payment_count: Number(existingDay?.payment_count || 0) + 1,
  }, { onConflict: 'staff_id,earning_date' });
}

export async function completeSale(
  items: CartItem[],
  paymentMethod: Sale['payment_method'] | 'split',
  paidAmount: number,
  customerName?: string,
  customerId?: string,
  paymentSplits?: PaymentSplit[],
  clientRef?: string,
  staffContext?: { id?: string; name?: string }
): Promise<SaleWithItems | null> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return null;

  const sessionStaff = (() => {
    try {
      return JSON.parse(sessionStorage.getItem('propos-current-staff-v2') || 'null') as { id?: string; name?: string } | null;
    } catch {
      return null;
    }
  })();
  // Normal çevrimiçi satışta aktif hesabı kullan. Offline kuyruğun senkronizasyonunda
  // ise satış oluşturulduğu anda kaydedilen personel bilgisini özellikle öne al ki
  // sonradan başka personel giriş yapmış olsa bile satış yanlış kişiye yazılmasın.
  const currentStaffId = staffContext?.id || sessionStaff?.id || '';
  const currentStaffName = staffContext?.name || sessionStaff?.name || '';
  const originalTotal = items.reduce((sum, item) => sum + Number(item.product.price) * item.quantity, 0);
  const total = items.reduce((sum, item) => sum + cartUnitPrice(item) * item.quantity, 0);
  const discountTotal = +(originalTotal - total).toFixed(2);
  const now = new Date().toISOString();
  if (!items.length || !items.every(i => Number.isFinite(Number(i.quantity)) && Number(i.quantity) > 0)) return null;
  if (!Number.isFinite(total) || total < 0 || !Number.isFinite(paidAmount) || paidAmount < 0) return null;
  // Nakit ödemede verilen para satıştan fazla olabilir; ödeme kaydına
  // satış tutarını yazar, para üstünü paid_amount alanında saklarız.
  // 0 TL toplamlı ücretsiz/test satışlarında 0 tutarlı ödeme satırı eklenmez.
  const splits = (paymentMethod === 'split'
    ? (paymentSplits || [])
    : [{
        method: paymentMethod as 'cash'|'card'|'credit',
        amount: total,
        customerId,
        customerName
      }]
  ).filter(p => Number(p.amount) > 0);

  // Migration uygulanmışsa satışın tamamını atomik RPC ile sunucuda bitir.
  // Eski kurulumlarda RPC yoksa aşağıdaki uyumluluk akışına geri dönülür.
  const rpcItems = items.map((item) => {
    const unitPrice = cartUnitPrice(item);
    const originalUnitPrice = Number(item.product.price);
    return {
      productId: item.product.id,
      productName: item.product.name,
      barcode: item.product.barcode,
      quantity: Number(item.quantity),
      unitPrice: Number(unitPrice),
      originalUnitPrice,
      discountAmount: +((originalUnitPrice - unitPrice) * item.quantity).toFixed(2),
    };
  });
  const rpcSplits = splits.map(p => ({ method: p.method, amount: Number(p.amount), customerId: p.customerId || null }));
  try {
    const { data: atomicSaleId, error: atomicError } = await supabase.rpc('complete_sale_atomic', {
      p_total: +total.toFixed(2),
      p_payment_method: paymentMethod,
      p_paid_amount: +(paymentMethod === 'split' ? total : paidAmount).toFixed(2),
      p_customer_id: customerId || null,
      p_customer_name: customerName || null,
      p_original_total: +originalTotal.toFixed(2),
      p_discount_total: discountTotal,
      p_client_ref: clientRef || null,
      p_items: rpcItems,
      p_splits: rpcSplits,
      p_staff_id: currentStaffId || null,
      p_staff_name: currentStaffName || null,
    });
    if (!atomicError && atomicSaleId) {
      const [{ data: atomicSale, error: atomicSaleError }, { data: atomicItems }] = await Promise.all([
        supabase.from('sales').select('*').eq('id', atomicSaleId).single(),
        supabase.from('sale_items').select('*').eq('sale_id', atomicSaleId),
      ]);
      if (!atomicSaleError && atomicSale) {
        const immediatePaid = splits
          .filter(p => p.method === 'cash' || p.method === 'card')
          .reduce((sum, p) => sum + Number(p.amount || 0), 0);
        // Atomic RPC artık personel ve günlük kazancı da aynı transaction içinde kaydeder.
        await writeAudit('sale_completed', 'sale', atomicSale.id, { total, paymentMethod, itemCount: items.length, atomic: true, immediatePaid });
        return { ...atomicSale, sale_items: (atomicItems || []) as SaleItem[] } as SaleWithItems;
      }
    }
  } catch (err) {
    console.warn('Atomik satış RPC kullanılamadı; uyumlu fallback kullanılacak:', err);
  }

  if (paymentMethod === 'split') {
    const splitTotal = splits.reduce((a, p) => a + Number(p.amount || 0), 0);
    if (Math.abs(splitTotal - total) > 0.01) return null;
    if (splits.some(p => p.method === 'credit' && !p.customerId)) return null;
  } else if (paymentMethod === 'credit' && !customerId) {
    return null;
  } else if (paymentMethod === 'cash' && paidAmount + 0.0001 < total) {
    return null;
  } else if (paymentMethod === 'card' && paidAmount + 0.0001 < total) {
    return null;
  }

  const baseSalePayload = {
    total: +total.toFixed(2),
    payment_method: paymentMethod,
    paid_amount: +(paymentMethod === 'split' ? total : paidAmount).toFixed(2),
    customer_name: customerName || null,
    staff_id: currentStaffId || null,
  };
  const extendedSalePayload = {
    ...baseSalePayload,
    original_total: +originalTotal.toFixed(2),
    discount_total: discountTotal,
    customer_id: customerId || null,
    payment_note: null,
    ...(clientRef ? { client_ref: clientRef } : {}),
  };

  if (clientRef) {
    const { data: existingSale } = await supabase.from('sales').select('*').eq('client_ref', clientRef).maybeSingle();
    if (existingSale) {
      const existingItems = await getSaleItems(existingSale.id);
      return { ...existingSale, sale_items: existingItems } as SaleWithItems;
    }
  }

  let saleInsert = await supabase.from('sales').insert(extendedSalePayload).select().single();
  if (saleInsert.error && /staff_id|customer_id|payment_note|discount_total|original_total|client_ref|schema cache|column|invalid input value/i.test(saleInsert.error.message || '')) {
    saleInsert = await supabase.from('sales').insert(baseSalePayload).select().single();
  }
  const { data: sale, error: saleError } = saleInsert;
  if (saleError || !sale) return null;

  const saleItems: Omit<SaleItem, 'id'>[] = items.map((item) => {
    const unit = cartUnitPrice(item);
    const original = Number(item.product.price);
    return { sale_id: sale.id, product_id: item.product.id, product_name: item.product.name, barcode: item.product.barcode, quantity: item.quantity, unit_price: unit, subtotal: +(unit * item.quantity).toFixed(2), original_unit_price: original, discount_amount: +((original-unit)*item.quantity).toFixed(2) };
  });
  let itemsResult:any, paymentResult:any;
  [itemsResult, paymentResult] = await Promise.all([
    supabase.from('sale_items').insert(saleItems),
    splits.length > 0 ? supabase.from('sale_payments').insert(splits.map(p => ({ sale_id: sale.id, method: p.method, amount: p.amount }))) : Promise.resolve({error:null})
  ]);
  if (itemsResult.error && /original_unit_price|discount_amount|schema cache|column/i.test(itemsResult.error.message || '')) {
    const legacySaleItems = saleItems.map(({ original_unit_price, discount_amount, ...row }) => row);
    itemsResult = await supabase.from('sale_items').insert(legacySaleItems);
  }
  if (itemsResult.error) { await supabase.from('sales').delete().eq('id', sale.id); console.error('Satış kalemleri kaydedilemedi:', itemsResult.error); return null; }
  let payError: { message?: string } | null = paymentResult?.error || null;
  // sale_payments tablosu eski kurulumlarda olmayabilir; bu durumda ana satış yine kaydedilsin.
  if (payError && !/sale_payments|schema cache|relation|does not exist|Could not find the table/i.test(payError.message || '')) {
    // Ödeme kırılımı yardımcı kayıttır; ana satışın tamamlanmasını engellemesin.
    // Base sales.payment_method / paid_amount alanları yine ana ödeme bilgisini tutar.
    console.warn('Ödeme kırılımı kaydedilemedi; ana satış korunuyor:', payError);
  }

  // Nakit/kart tahsilatı satış anında yapıldığı için çalışan kazancı da hemen oluşturulur.
  // Veresiye kısmı ise müşteri gerçekten ödeme yaptığında hesaplanır.
  if ((currentStaffId || currentStaffName) && splits.length > 0) {
    const immediatePaid = splits
      .filter(p => p.method === 'cash' || p.method === 'card')
      .reduce((sum, p) => sum + Number(p.amount || 0), 0);
    if (immediatePaid > 0) {
      let resolvedStaff: { id: string; earning_rate: number } | null = null;
      if (currentStaffId) {
        const { data: byId } = await supabase.from('staff').select('id,earning_rate').eq('id', currentStaffId).eq('active', true).maybeSingle();
        resolvedStaff = byId || null;
      }
      if (!resolvedStaff && currentStaffName) {
        const { data: namedStaff } = await supabase.from('staff').select('id,earning_rate,name').eq('active', true).ilike('name', currentStaffName).limit(1);
        resolvedStaff = namedStaff?.[0] || null;
      }
      if (resolvedStaff) {
        const rate = Math.max(0, Math.min(100, Number(resolvedStaff.earning_rate || 0)));
        if (rate > 0) {
          const earningAmount = +(immediatePaid * rate / 100).toFixed(2);
          const { data: saleMeta } = await supabase.from('sales').select('business_id').eq('id', sale.id).maybeSingle();
          const { error: earningError } = await supabase.from('staff_earnings').upsert({
            business_id: saleMeta?.business_id || null,
            staff_id: resolvedStaff.id,
            sale_id: sale.id,
            amount_paid: immediatePaid,
            rate_percent: rate,
            earning_amount: earningAmount,
            source: 'sale_payment'
          }, { onConflict: 'sale_id' });
          if (earningError) {
            console.warn('Satış çalışan kazancı kaydedilemedi:', earningError);
          } else {
            const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Istanbul' });
            await supabase.from('staff_daily_earnings').upsert({
              business_id: saleMeta?.business_id || null,
              staff_id: resolvedStaff.id,
              earning_date: day,
              amount_paid: immediatePaid,
              earning_amount: earningAmount,
              payment_count: 1
            }, { onConflict: 'staff_id,earning_date' });
          }
        }
      }
    }
  }

  const appliedStock: { productId: string; quantity: number; before: number; name: string }[] = [];
  const rollbackSale = async () => {
    for (const row of [...appliedStock].reverse()) {
      const restored = await supabase.rpc('record_stock_movement', {
        p_product_id: row.productId, p_type: 'return', p_quantity: row.quantity,
        p_reason: `Satış geri alma ${sale.id}`, p_sale_id: sale.id, p_staff_id: currentStaffId || null,
      });
      if (restored.error || restored.data !== true) {
        await supabase.from('products').update({ stock: row.before }).eq('id', row.productId);
      }
    }
    await supabase.from('sale_items').delete().eq('sale_id', sale.id);
    await supabase.from('sale_payments').delete().eq('sale_id', sale.id);
    await supabase.from('sales').delete().eq('id', sale.id);
  };

  const stockRows = await Promise.all(items.map(async (item) => {
    const { data: currentProduct, error: prodErr } = await supabase.from('products').select('stock,name').eq('id', item.product.id).single();
    return { item, currentProduct, prodErr };
  }));
  if (stockRows.some(r => r.prodErr || !r.currentProduct || Number(r.currentProduct.stock) < Number(r.item.quantity))) {
    await Promise.all([
      supabase.from('sale_items').delete().eq('sale_id', sale.id),
      supabase.from('sale_payments').delete().eq('sale_id', sale.id),
      supabase.from('sales').delete().eq('id', sale.id)
    ]);
    return null;
  }
  const stockResults = await Promise.all(stockRows.map(async ({item,currentProduct}) => {
    const before = Number(currentProduct!.stock);
    const ok = await supabase.rpc('record_stock_movement', { p_product_id:item.product.id, p_type:'sale', p_quantity:item.quantity, p_reason:`Satış ${sale.id}`, p_sale_id:sale.id, p_staff_id:currentStaffId || null });
    if (!ok.error && ok.data === true) return { success:true, productId:item.product.id, quantity:Number(item.quantity), before, name:currentProduct!.name };
    const nextStock = before - Number(item.quantity);
    if (nextStock < 0) return { success:false, productId:item.product.id, quantity:Number(item.quantity), before, name:currentProduct!.name };
    const fallbackStock = await supabase.from('products').update({ stock: nextStock }).eq('id', item.product.id);
    if (fallbackStock.error) return { success:false, productId:item.product.id, quantity:Number(item.quantity), before, name:currentProduct!.name };
    const movementResult = await supabase.from('stock_movements').insert({product_id:item.product.id,product_name:currentProduct!.name,movement_type:'sale',quantity:item.quantity,before_stock:before,after_stock:nextStock,sale_id:sale.id,staff_id:currentStaffId || null});
    if (movementResult.error && !/stock_movements|schema cache|relation|does not exist/i.test(movementResult.error.message || '')) return { success:false, productId:item.product.id, quantity:Number(item.quantity), before, name:currentProduct!.name };
    return { success:true, productId:item.product.id, quantity:Number(item.quantity), before, name:currentProduct!.name };
  }));
  if (stockResults.some(r => !r.success)) {
    await Promise.all(stockResults.filter(r => r.success).map(async row => {
      const restored = await supabase.rpc('record_stock_movement', { p_product_id: row.productId, p_type: 'return', p_quantity: row.quantity, p_reason: `Satış geri alma ${sale.id}`, p_sale_id: sale.id, p_staff_id: null });
      if (restored.error || restored.data !== true) await supabase.from('products').update({ stock: row.before }).eq('id', row.productId);
    }));
    await Promise.all([
      supabase.from('sale_items').delete().eq('sale_id', sale.id),
      supabase.from('sale_payments').delete().eq('sale_id', sale.id),
      supabase.from('sales').delete().eq('id', sale.id)
    ]);
    return null;
  }
  appliedStock.push(...stockResults.filter(r => r.success).map(r => ({productId:r.productId, quantity:r.quantity, before:r.before, name:r.name})));

  const creditPart = splits.filter(p => p.method === 'credit').reduce((sum,p)=>sum+p.amount,0);
  if (creditPart > 0) {
    const cid = splits.find(p=>p.method==='credit')?.customerId || customerId;
    if (!cid) {
      await rollbackSale();
      return null;
    }
    // Some older ProPOS databases do not expose the helper RPC. Use the
    // customer row directly so credit sales keep working even before that
    // optional helper migration is installed.
    const { data: cust, error: custReadError } = await supabase
      .from('customers')
      .select('balance')
      .eq('id', cid)
      .single();
    if (custReadError || !cust) {
      await rollbackSale();
      console.error('Müşteri bakiyesi okunamadı:', custReadError);
      return null;
    }
    const nextBalance = Number(cust.balance || 0) + creditPart;
    const balanceUpdate = await supabase
      .from('customers')
      .update({ balance: nextBalance })
      .eq('id', cid);
    if (balanceUpdate.error) {
      await rollbackSale();
      console.error('Müşteri bakiyesi güncellenemedi:', balanceUpdate.error);
      return null;
    }
  }
  await writeAudit('sale_completed', 'sale', sale.id, { total, paymentMethod, itemCount: items.length });
  return { ...sale, sale_items: saleItems as SaleItem[] } as SaleWithItems;
}

export async function addStock(product: Product, quantity: number, reason = 'Stok girişi', staffId?: string) {
  if (!Number.isFinite(quantity) || quantity <= 0) return false;
  const { data, error } = await supabase.rpc('record_stock_movement', { p_product_id: product.id, p_type:'in', p_quantity:quantity, p_reason:reason, p_staff_id:staffId || null });
  if (!error && data === true) return true;
  const next = Number(product.stock || 0) + quantity;
  const fallback = await supabase.from('products').update({ stock: next }).eq('id', product.id);
  if (!fallback.error) {
    await supabase.from('stock_movements').insert({ product_id: product.id, product_name: product.name, movement_type:'in', quantity, before_stock:Number(product.stock||0), after_stock:next, reason, staff_id:staffId||null });
    return true;
  }
  console.error('Stok girişi başarısız:', error || fallback.error);
  return false;
}

export async function setStock(product: Product, quantity: number, reason = 'Stok düzeltme', staffId?: string) {
  if (!Number.isFinite(quantity) || quantity < 0) return false;
  const { data, error } = await supabase.rpc('record_stock_movement', { p_product_id: product.id, p_type:'adjustment', p_quantity:quantity, p_reason:reason, p_staff_id:staffId || null });
  if (!error && data === true) return true;
  const fallback = await supabase.from('products').update({ stock: quantity }).eq('id', product.id);
  if (!fallback.error) {
    await supabase.from('stock_movements').insert({ product_id: product.id, product_name: product.name, movement_type:'adjustment', quantity, before_stock:Number(product.stock||0), after_stock:quantity, reason, staff_id:staffId||null });
    return true;
  }
  console.error('Stok düzeltme başarısız:', error || fallback.error);
  return false;
}


export type ProcessSaleReturnInput = {
  saleId: string;
  items: Array<{ saleItemId: string; quantity: number }>;
  reason?: string;
  staffId?: string | null;
  returnMethod?: 'original'|'cash'|'card'|'credit';
};

export async function processSaleReturn(input: ProcessSaleReturnInput): Promise<{success:boolean; refundAmount:number; costReversed:number; error?:string}> {
  if (!input.saleId || !input.items.length) return { success:false, refundAmount:0, costReversed:0, error:'İade kalemleri gerekli.' };
  const { data, error } = await supabase.rpc('process_sale_return', {
    p_sale_id: input.saleId,
    p_items: input.items,
    p_reason: input.reason?.trim() || null,
    p_staff_id: input.staffId || null,
    p_return_method: input.returnMethod || 'original',
  });
  if (error) return { success:false, refundAmount:0, costReversed:0, error:error.message };
  const refundAmount=Number(data?.refund_amount||0);
  const costReversed=Number(data?.cost_reversed||0);
  await writeAudit('sale_partial_or_full_return','sale',input.saleId,{refund_amount:refundAmount,item_count:input.items.length,reason:input.reason||null,return_method:input.returnMethod||'original'});
  return { success:true, refundAmount, costReversed };
}

export async function partialReturn(saleId: string, saleItemId: string, quantity: number, reason?: string) {
  const { data, error } = await supabase.rpc('record_partial_return', {p_sale_id:saleId,p_sale_item_id:saleItemId,p_quantity:quantity,p_reason:reason||null});
  return !error && Number(data||0) > 0;
}

export function useStockMovements(productId?: string) {
  const [rows,setRows]=useState<StockMovement[]>([]); const [loading,setLoading]=useState(true);
  const load=useCallback(async()=>{ setLoading(true); let q=supabase.from('stock_movements').select('*').order('created_at',{ascending:false}).limit(500); if(productId) q=q.eq('product_id',productId); const {data,error}=await q; if(error) console.error(error); setRows((data||[]) as StockMovement[]); setLoading(false);},[productId]);
  useEffect(()=>{load();},[load]); return {movements:rows,loading,reload:load};
}

const STAFF_LOCAL_KEY='propos-staff-local-v1';
function getLocalStaff(): Staff[] { try { const raw=JSON.parse(localStorage.getItem(STAFF_LOCAL_KEY)||'[]'); return Array.isArray(raw)?raw as Staff[]:[]; } catch { return []; } }
function saveLocalStaff(rows: Staff[]) { try { localStorage.setItem(STAFF_LOCAL_KEY, JSON.stringify(rows)); } catch {} }
function isMissingStaffTable(error:any) { const msg = `${error?.message||''} ${error?.code||''}`.toLowerCase(); return msg.includes('relation') && msg.includes('staff') || msg.includes('staff') && (msg.includes('schema cache') || msg.includes('does not exist') || msg.includes('404')); }

async function syncLocalStaffToSupabase(localRows: Staff[]) {
  for (const row of localRows) {
    const { data: existing } = await supabase.from('staff').select('id,name,role,active,earning_rate').eq('id', row.id).maybeSingle();
    if (existing) {
      if (Number(existing.earning_rate ?? 0) !== Number(row.earning_rate ?? 0)) {
        await supabase.from('staff').update({ earning_rate: Number(row.earning_rate ?? 0), name: row.name, role: row.role, active: row.active }).eq('id', row.id);
      }
      continue;
    }
    const { data: created, error: insertError } = await supabase.from('staff').insert({
      id: row.id, name: row.name, role: row.role, active: row.active, earning_rate: Number(row.earning_rate ?? 0), pin: null
    }).select().single();
    if (insertError || !created) {
      console.error("Yerel personel Supabase\'e aktarılamadı:", insertError);
      continue;
    }
    if (row.pin) {
      const { error: pinError } = await supabase.rpc('set_staff_pin', { p_staff_id: row.id, p_pin: row.pin });
      if (pinError) console.error('Personel PIN senkronizasyonu başarısız:', pinError);
    }
  }
}

export function useStaff() {
  const [staff,setStaff]=useState<Staff[]>([]);
  const [error,setError]=useState<string|null>(null);
  const load=useCallback(async()=>{
    const {data,error}=await supabase.from('staff').select('*').order('name');
    if (!error) {
      if ((data || []).length === 0) {
        const localRows = getLocalStaff();
        if (localRows.length) {
          await syncLocalStaffToSupabase(localRows);
          const { data: synced, error: syncError } = await supabase.from('staff').select('*').order('name');
          if (!syncError && (synced || []).length) {
            setStaff((synced || []) as Staff[]); setError(null); saveLocalStaff((synced || []) as Staff[]); return;
          }
        }
      }
      setStaff((data||[]) as Staff[]); setError(null); saveLocalStaff((data||[]) as Staff[]); return;
    }
    console.error('Personeller yüklenemedi:',error);
    if (isMissingStaffTable(error)) { setStaff(getLocalStaff()); setError("Personel tablosu Supabase’de henüz oluşturulmamış. Şimdilik bu cihazda yerel kayıt modu kullanılıyor."); }
    else { setStaff(getLocalStaff()); setError(error.message || 'Personeller yüklenemedi.'); }
  },[]);
  useEffect(()=>{load()},[load]);
  return {staff,error,reload:load};
}

export async function addStaff(name:string,pin?:string,role:Staff['role']='cashier',earningRate:number=0){
  const clean=name.trim();
  if(!clean) return {data:null,error:'Ad Soyad zorunludur.' as string};
  if(!pin || pin.trim().length < 4) return {data:null,error:'PIN / Şifre en az 4 karakter olmalı.' as string};
  let {data,error}=await supabase.from('staff').insert({name:clean,pin:null,role,active:true,earning_rate:Number.isFinite(earningRate)?Math.max(0,Math.min(100,earningRate)):0}).select().single();
  if (!error && data) {
    await writeAudit('staff_created','staff',data.id,{name:clean,role,earning_rate:earningRate});
    const pinResult=await supabase.rpc('set_staff_pin',{p_staff_id:data.id,p_pin:pin.trim()});
    if(pinResult.error || pinResult.data!==true){
      const fallback=await supabase.from('staff').update({pin:pin.trim()}).eq('id',data.id);
      if(fallback.error){ await supabase.from('staff').delete().eq('id',data.id); return {data:null,error:pinResult.error?.message||fallback.error.message||'PIN kaydedilemedi.'}; }
      data={...data,pin:pin.trim()};
    } else data={...data,pin:null,pin_hash:'stored'} as any;
    const rows=getLocalStaff().filter(x=>x.id!==data.id); saveLocalStaff([...rows,data as Staff]); return {data:data as Staff,error:null};
  }
  if (isMissingStaffTable(error)) {
    const local:Staff={id:crypto.randomUUID(),name:clean,pin:pin.trim(),role,active:true,earning_rate:Number.isFinite(earningRate)?Math.max(0,Math.min(100,earningRate)):0,created_at:new Date().toISOString()};
    saveLocalStaff([...getLocalStaff(),local]); return {data:local,error:null,local:true};
  }
  console.error('Personel eklenemedi:',error); return {data:null,error:error?.message||'Personel eklenemedi.' as string};
}

export async function updateStaff(id:string, patch:Partial<Staff>){
  const {error}=await supabase.from('staff').update(patch).eq('id',id);
  if (!error) { saveLocalStaff(getLocalStaff().map(x=>x.id===id?{...x,...patch}:x)); await writeAudit('staff_updated','staff',id,{fields:Object.keys(patch)}); return true; }
  if (isMissingStaffTable(error)) { saveLocalStaff(getLocalStaff().map(x=>x.id===id?{...x,...patch}:x)); return true; }
  console.error('Personel güncellenemedi:',error); return false;
}

export async function deleteStaff(id:string){
  const {error}=await supabase.from('staff').delete().eq('id',id);
  if(!error){ saveLocalStaff(getLocalStaff().filter(x=>x.id!==id)); await writeAudit('staff_deleted','staff',id); return true; }
  const fallback=await supabase.from('staff').update({active:false}).eq('id',id);
  if(!fallback.error){ saveLocalStaff(getLocalStaff().map(x=>x.id===id?{...x,active:false}:x)); return true; }
  if(isMissingStaffTable(error) || isMissingStaffTable(fallback.error)){ saveLocalStaff(getLocalStaff().filter(x=>x.id!==id)); return true; }
  console.error('Personel silinemedi:',error,fallback.error); return false;
}

export type StaffConsumptionInput = {
  productId: string;
  quantity: number;
  staffId: string;
  type: 'personal' | 'gift';
  note?: string;
};

export async function recordStaffConsumption(input: StaffConsumptionInput): Promise<{ success: boolean; id?: string; error?: string }> {
  const quantity = Number(input.quantity);
  if (!input.productId || !input.staffId || !Number.isFinite(quantity) || quantity <= 0) {
    return { success: false, error: 'Geçerli ürün, personel ve adet gerekli.' };
  }
  const { data, error } = await supabase.rpc('record_staff_consumption', {
    p_product_id: input.productId,
    p_quantity: quantity,
    p_staff_id: input.staffId,
    p_consumption_type: input.type,
    p_note: input.note?.trim() || null,
  });
  if (error) {
    console.error('Personel tüketimi kaydedilemedi:', error);
    return { success: false, error: error.message || 'İşlem kaydedilemedi.' };
  }
  return { success: true, id: String(data) };
}


export type StaffConsumptionBatchItem = { productId: string; quantity: number };

export async function recordStaffConsumptionBatch(input: {
  items: StaffConsumptionBatchItem[];
  staffId: string;
  type: 'personal' | 'gift';
  note?: string;
}): Promise<{ success: boolean; error?: string; rows?: StaffConsumption[] }> {
  if (!input.staffId || !input.items.length) {
    return { success: false, error: 'En az bir ürün ve aktif personel gerekli.' };
  }
  const payloadItems = input.items.map((item) => ({ productId: item.productId, quantity: Number(item.quantity) }));
  const { data, error } = await supabase.rpc('record_staff_consumption_batch', {
    p_staff_id: input.staffId,
    p_consumption_type: input.type,
    p_items: payloadItems,
    p_note: input.note?.trim() || null,
  });
  if (error) {
    console.error('Toplu personel tüketimi kaydedilemedi:', error);
    return { success: false, error: error.message || 'İşlem kaydedilemedi.' };
  }
  await writeAudit('staff_consumption','staff',input.staffId,{consumption_type:input.type,item_count:input.items.length,note:input.note||null});
  const rows = Array.isArray((data as any)?.rows) ? (data as any).rows as StaffConsumption[] : [];
  return { success: true, rows };
}

export function useStaffConsumptions(staffId?: string, days = 31) {
  const [rows, setRows] = useState<StaffConsumption[]>([]);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    const since = new Date(Date.now() - days * 86400000).toISOString();
    let query = supabase.from('staff_consumptions').select('*').gte('created_at', since).order('created_at', { ascending: false });
    if (staffId) query = query.eq('staff_id', staffId);
    const { data, error } = await query;
    if (error) console.error('Personel tüketimleri yüklenemedi:', error);
    setRows((data || []) as StaffConsumption[]);
    setLoading(false);
  }, [staffId, days]);
  useEffect(() => { load(); }, [load]);
  return { rows, loading, reload: load };
}


export type StaffFinancialSummary = {
  financial_start_at: string | null;
  total_earnings: number;
  total_collected: number;
  personal_consumption: number;
  total_payouts: number;
  available_balance: number;
};

export async function recordStaffPayout(staffId: string, amount: number, note?: string): Promise<{ success: boolean; error?: string; id?: string; amount?: number; available_balance_after?: number }> {
  const value = Number(amount);
  if (!staffId || !Number.isFinite(value) || value <= 0) {
    return { success: false, error: 'Geçerli bir personel ve tutar girin.' };
  }
  const { data, error } = await supabase.rpc('record_staff_payout', {
    p_staff_id: staffId,
    p_amount: value,
    p_note: note?.trim() || null,
  });
  if (error) {
    console.error('Personel kazanç ödemesi kaydedilemedi:', error);
    return { success: false, error: error.message || 'Kazanç ödemesi kaydedilemedi.' };
  }
  const payload = (data || {}) as { id?: string; amount?: number; available_balance_after?: number };
  await writeAudit('staff_payout','staff',staffId,{amount:value,note:note||null,available_balance_after:Number(payload.available_balance_after||0)});
  return {
    success: true,
    id: payload.id,
    amount: Number(payload.amount || value),
    available_balance_after: Number(payload.available_balance_after || 0),
  };
}

export function useStaffFinancialSummary(staffId?: string, financialStartAt?: string) {
  const [summary, setSummary] = useState<StaffFinancialSummary>({ financial_start_at: null, total_earnings: 0, total_collected: 0, personal_consumption: 0, total_payouts: 0, available_balance: 0 });
  const [payouts, setPayouts] = useState<StaffPayout[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!staffId) {
      setSummary({ financial_start_at: null, total_earnings: 0, total_collected: 0, personal_consumption: 0, total_payouts: 0, available_balance: 0 });
      setPayouts([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const [{ data: summaryData, error: summaryError }, { data: payoutData, error: payoutError }] = await Promise.all([
      supabase.rpc('get_staff_financial_summary', { p_staff_id: staffId }),
      (() => {
        let q = supabase.from('staff_payouts').select('*').eq('staff_id', staffId).order('created_at', { ascending: false }).limit(50);
        if (financialStartAt) q = q.gte('created_at', financialStartAt);
        return q;
      })(),
    ]);
    if (summaryError) console.error('Personel bakiye özeti yüklenemedi:', summaryError);
    if (payoutError) console.error('Personel kazanç ödemeleri yüklenemedi:', payoutError);
    const next = (summaryData || {}) as Partial<StaffFinancialSummary>;
    setSummary({
      financial_start_at: next.financial_start_at ? String(next.financial_start_at) : (financialStartAt || null),
      total_earnings: Number(next.total_earnings || 0),
      total_collected: Number(next.total_collected || 0),
      personal_consumption: Number(next.personal_consumption || 0),
      total_payouts: Number(next.total_payouts || 0),
      available_balance: Number(next.available_balance || 0),
    });
    setPayouts((payoutData || []) as StaffPayout[]);
    setLoading(false);
  }, [staffId, financialStartAt]);

  useEffect(() => { load(); }, [load]);
  return { summary, payouts, loading, reload: load };
}

export function useStaffEarnings(staffId?: string, days = 31) {
  const [earnings, setEarnings] = useState<StaffEarning[]>([]);
  const [daily, setDaily] = useState<Array<{ earning_date:string; earning_amount:number; amount_paid:number; payment_count:number }>>([]);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    if (!staffId) { setEarnings([]); setDaily([]); setLoading(false); return; }
    setLoading(true);
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const [{ data, error }, { data: dailyData, error: dailyError }] = await Promise.all([
      supabase.from('staff_earnings').select('*').eq('staff_id', staffId).gte('created_at', since).order('created_at', { ascending: false }),
      supabase.from('staff_daily_earnings').select('earning_date,earning_amount,amount_paid,payment_count').eq('staff_id', staffId).gte('earning_date', new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0,10)).order('earning_date', { ascending: false }),
    ]);
    if (error) console.error('Personel kazançları yüklenemedi:', error);
    if (dailyError) console.error('Günlük personel kazançları yüklenemedi:', dailyError);
    setEarnings((data || []) as StaffEarning[]);
    setDaily((dailyData || []) as any);
    setLoading(false);
  }, [staffId, days]);
  useEffect(() => { load(); }, [load]);
  return { earnings, daily, loading, reload: load };
}

const OFFLINE_QUEUE_KEY='propos-offline-sales-v2';
export type OfflineSalePayload = {
  queue_id: string; items: CartItem[]; paymentMethod: Sale['payment_method']; paidAmount: number;
  customerName?: string; customerId?: string; paymentSplits?: PaymentSplit[];
  staff_id?: string | null; staff_name?: string | null; queued_at: string;
};
export function getOfflineSales(): OfflineSalePayload[]{
  try { const raw=JSON.parse(localStorage.getItem(OFFLINE_QUEUE_KEY)||'[]'); return Array.isArray(raw)?raw:[]; } catch { return []; }
}
export function queueOfflineSale(payload: Omit<OfflineSalePayload,'queue_id'|'queued_at'>){
  try {
    const q=getOfflineSales();
    let sessionStaff: { id?: string; name?: string } | null = null;
    try { sessionStaff = JSON.parse(sessionStorage.getItem('propos-current-staff-v2') || 'null'); } catch {}
    q.push({
      ...payload,
      // Satışın kuyruğa girdiği anda aktif hesabı mühürle. Senkronizasyon sırasında
      // farklı personel oturum açmış olsa bile satış ilk kişide kalır.
      staff_id: payload.staff_id ?? sessionStaff?.id ?? null,
      staff_name: payload.staff_name ?? sessionStaff?.name ?? null,
      queue_id: crypto.randomUUID(),
      queued_at:new Date().toISOString()
    });
    localStorage.setItem(OFFLINE_QUEUE_KEY,JSON.stringify(q));
    // Reserve/decrement cached stock immediately so consecutive offline sales
    // cannot keep adding the same cached inventory indefinitely.
    const cached = getOfflineProducts();
    if (cached.length) {
      const next = cached.map((p) => {
        const sold = payload.items
          .filter((i) => i.product.id === p.id)
          .reduce((sum, i) => sum + Number(i.quantity || 0), 0);
        return sold > 0 ? { ...p, stock: Math.max(0, Number(p.stock || 0) - sold) } : p;
      });
      writeOfflineCache(OFFLINE_PRODUCTS_KEY, next);
    }
    notifyOfflineSync();
    return true;
  } catch (error) {
    console.error('Offline satış kaydedilemedi:', error);
    return false;
  }
}
export async function syncOfflineSales(){
  if(!navigator.onLine) return {synced:0,failed:getOfflineSales().length};
  const q=getOfflineSales(); let synced=0; const remain: OfflineSalePayload[]=[];
  for(const x of q){
    try {
      const sale=await completeSale(
        x.items,
        x.paymentMethod,
        x.paidAmount,
        x.customerName,
        x.customerId,
        x.paymentSplits,
        x.queue_id,
        { id: x.staff_id || undefined, name: x.staff_name || undefined }
      );
      if(sale) synced++; else remain.push(x);
    } catch (error) { console.error('Offline satış senkronizasyonu başarısız:',x.queue_id,error); remain.push(x); }
  }
  localStorage.setItem(OFFLINE_QUEUE_KEY,JSON.stringify(remain));
  notifyOfflineSync();
  return {synced,failed:remain.length};
}

export function useSales(limit = 50) {
  const [sales, setSales] = useState<Sale[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const target = Math.max(1, Number(limit || 50));
    const pageSize = Math.min(1000, target);
    const chunks: Sale[] = [];
    let offset = 0;
    let lastError: any = null;
    while (chunks.length < target) {
      let result = await supabase
        .from('sales')
        .select('*')
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .range(offset, offset + pageSize - 1);
      if (result.error && /deleted_at|schema cache|column/i.test(result.error.message || '')) {
        result = await supabase
          .from('sales')
          .select('*')
          .order('created_at', { ascending: false })
          .range(offset, offset + pageSize - 1);
      }
      if (result.error) { lastError = result.error; break; }
      const rows = (result.data || []) as Sale[];
      chunks.push(...rows);
      if (rows.length < pageSize) break;
      offset += pageSize;
    }
    if (lastError) console.error('Satışlar yüklenemedi:', lastError);
    setSales(chunks.slice(0, target));
    setLoading(false);
  }, [limit]);

  useEffect(() => {
    load();
    const channel = supabase
      .channel('sales-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sales' }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [load]);

  return { sales, loading, reload: load };
}

export type StoreSettings = {
  storeName: string; storeAddress: string; storePhone: string; currency: string;
  receiptFooter: string; taxRate: string; lowStockDefault: string;
};

export async function loadStoreSettings(defaults: StoreSettings): Promise<StoreSettings> {
  try {
    const { data } = await supabase.from('store_settings').select('settings').limit(1).maybeSingle();
    if (data?.settings && typeof data.settings === 'object') return { ...defaults, ...(data.settings as Partial<StoreSettings>) };
  } catch {}
  return defaults;
}

export async function saveStoreSettings(settings: StoreSettings): Promise<boolean> {
  try {
    const { data: business } = await supabase.rpc('get_default_business_id');
    const businessId = data as string | null;
    if (!businessId) return false;
    const { error } = await supabase.from('store_settings').upsert({ business_id: businessId, settings, updated_at: new Date().toISOString() }, { onConflict: 'business_id' });
    return !error;
  } catch { return false; }
}

// ===== Müşteriler =====

export function useCustomers(options?: { remoteOnly?: boolean }) {
  const remoteOnly = Boolean(options?.remoteOnly);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const cached = getOfflineCustomers();
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      if (remoteOnly) { setCustomers([]); setLoading(false); return; }
      setCustomers(cached);
      setLoading(false);
      return;
    }
    setLoading(true);
    const { data, error } = await supabase
      .from('customers')
      .select('*')
      .order('name', { ascending: true });
    if (error) {
      console.error('Müşteriler yüklenemedi:', error);
      if (!remoteOnly && cached.length) setCustomers(cached);
      else setCustomers([]);
    } else {
      setCustomers(data || []);
      writeOfflineCache(OFFLINE_CUSTOMERS_KEY, data || []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    const channel = supabase
      .channel('customers-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'customers' }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [load]);

  return { customers, loading, reload: load };
}

export async function addCustomer(name: string, phone?: string): Promise<Customer | null> {
  const cleanName = name.trim();
  const cleanPhone = phone?.trim() || null;
  if (!cleanName) return null;

  try {
    // Resolve the active business explicitly. This avoids relying on a DB
    // DEFAULT and makes desktop/licensed installations deterministic.
    const { data: businessId, error: businessError } = await supabase.rpc('get_default_business_id');
    if (businessError || !businessId) {
      console.error('Müşteri eklenemedi: aktif işletme bulunamadı.', businessError);
      return null;
    }

    const { data, error } = await supabase
      .from('customers')
      .insert({ name: cleanName, phone: cleanPhone, balance: 0, business_id: businessId as string })
      .select('*')
      .single();
    if (error || !data) {
      console.error('Müşteri eklenemedi:', error);
      return null;
    }
    try { await writeAudit('customer_created', 'customer', data.id, { name: data.name, phone: data.phone }); } catch (auditError) {
      console.warn('Müşteri kaydedildi fakat işlem günlüğü yazılamadı:', auditError);
    }
    writeOfflineCache(OFFLINE_CUSTOMERS_KEY, [data as Customer, ...getOfflineCustomers().filter(c => c.id !== data.id)]);
    return data as Customer;
  } catch (error) {
    console.error('Müşteri ekleme beklenmeyen hata:', error);
    return null;
  }
}

export async function updateCustomer(id: string, name: string, phone?: string): Promise<boolean> {
  const { error } = await supabase
    .from('customers')
    .update({ name: name.trim(), phone: phone?.trim() || null })
    .eq('id', id);
  if (error) {
    console.error('Müşteri güncellenemedi:', error);
    return false;
  }
  await writeAudit('customer_updated', 'customer', id, { name: name.trim(), phone: phone?.trim() || null });
  return true;
}

export async function deleteCustomer(id: string): Promise<boolean> {
  const { error } = await supabase
    .from('customers')
    .delete()
    .eq('id', id);
  if (error) {
    console.error('Müşteri silinemedi:', error);
    return false;
  }
  await writeAudit('customer_deleted', 'customer', id);
  return true;
}

export async function payCustomerDebt(id: string, amount: number, note?: string, staffId?: string): Promise<{ success: boolean; amount: number }> {
  if (!Number.isFinite(amount) || amount <= 0) return { success: false, amount: 0 };

  const { data, error } = await supabase.rpc('pay_customer_debt', {
    p_customer_id: id,
    p_amount: amount,
    p_note: note?.trim() || null,
    p_staff_id: staffId || null,
  });

  const rpcPaid = data == null ? NaN : Number(data);
  if (!error && Number.isFinite(rpcPaid)) {
    if (rpcPaid > 0) await writeAudit('customer_payment', 'customer', id, { amount: rpcPaid, note: note?.trim() || null });
    return { success: rpcPaid > 0, amount: rpcPaid };
  }

  // Yeni migration henüz uygulanmadıysa eski şema ile güvenli geri dönüş.
  const { data: cust } = await supabase.from('customers').select('balance').eq('id', id).maybeSingle();
  if (!cust) return { success: false, amount: 0 };
  const payment = Math.min(Number(cust.balance || 0), amount);
  if (payment <= 0) return { success: false, amount: 0 };

  const { error: updateError } = await supabase.from('customers').update({
    balance: Number(cust.balance || 0) - payment,
  }).eq('id', id);
  if (updateError) {
    console.error('Borç ödemesi yapılamadı:', updateError);
    return { success: false, amount: 0 };
  }

  try {
    const { data: insertedPayment } = await supabase.from('customer_payments').insert({ customer_id: id, amount: payment, note: note?.trim() || null, staff_id: staffId || null }).select().single();
    if (staffId && insertedPayment) {
      const { data: staffRow } = await supabase.from('staff').select('earning_rate').eq('id', staffId).maybeSingle();
      const rate = Math.max(0, Math.min(100, Number(staffRow?.earning_rate || 0)));
      if (rate > 0) await supabase.from('staff_earnings').insert({ staff_id: staffId, customer_payment_id: insertedPayment.id, amount_paid: payment, rate_percent: rate, earning_amount: +(payment * rate / 100).toFixed(2), source: 'customer_payment' });
    }
  } catch {
    // Eski veritabanında ödeme tablosu yoksa bakiye yine güncellenmiş olur.
  }
  // Migration henüz uygulanmadıysa da mümkünse kapanan açık veresiye kayıtlarını işaretle.
  if (Number(cust.balance || 0) - payment <= 0.01) {
    const { data: customerRow } = await supabase.from('customers').select('name').eq('id', id).maybeSingle();
    let settleQuery = supabase.from('sales').update({ settled_at: new Date().toISOString() }).is('settled_at', null).in('payment_method', ['credit','split']);
    if (customerRow?.name) {
      settleQuery = settleQuery.or(`customer_id.eq.${id},and(customer_id.is.null,customer_name.eq.${customerRow.name.replace(/,/g, '')})`);
    } else {
      settleQuery = settleQuery.eq('customer_id', id);
    }
    await settleQuery;
  }
  await writeAudit('customer_payment', 'customer', id, { amount: payment, note: note?.trim() || null });
  return { success: true, amount: payment };
}


export type CustomerDebtAdjustment = {
  id: string;
  customer_id: string;
  amount: number;
  note: string | null;
  staff_id: string | null;
  source: string;
  created_at: string;
  business_id: string | null;
};

export async function lendCustomerCash(
  cashSessionId: string,
  customerId: string,
  amount: number,
  note?: string,
  staffId?: string | null,
): Promise<{ success: boolean; amount: number; balance?: number }> {
  if (!cashSessionId || !customerId || !Number.isFinite(amount) || amount <= 0) {
    return { success: false, amount: 0 };
  }
  const resolvedStaffId = await resolveRemoteStaffId(staffId);
  if (!resolvedStaffId) {
    console.error('Müşteriye borç para verilemedi: aktif personel bulunamadı.');
    return { success: false, amount: 0 };
  }

  const { data, error } = await supabase.rpc('lend_customer_cash', {
    p_cash_session_id: cashSessionId,
    p_customer_id: customerId,
    p_amount: +amount.toFixed(2),
    p_staff_id: resolvedStaffId,
    p_note: note?.trim() || null,
  });
  if (error || !data?.ok) {
    console.error('Müşteriye borç para verilemedi:', error || data);
    return { success: false, amount: 0 };
  }

  await writeAudit('customer_cash_loan', 'customer', customerId, {
    amount: Number(data.amount || amount),
    cash_session_id: cashSessionId,
    note: note?.trim() || null,
    earning: 0,
  });
  return {
    success: true,
    amount: Number(data.amount || amount),
    balance: Number(data.balance || 0),
  };
}

export function useCustomerDebtHistory(customerId: string | null) {
  const [sales, setSales] = useState<SaleWithItems[]>([]);
  const [archiveSales, setArchiveSales] = useState<SaleWithItems[]>([]);
  const [payments, setPayments] = useState<CustomerPayment[]>([]);
  const [debtAdjustments, setDebtAdjustments] = useState<CustomerDebtAdjustment[]>([]);
  const [salePayments, setSalePayments] = useState<SalePayment[]>([]);
  const [staffNames, setStaffNames] = useState<Record<string, string>>({});
  const [currentBalance, setCurrentBalance] = useState<number | null>(null);
  const [customerName, setCustomerName] = useState<string>('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!customerId) {
      setSales([]); setArchiveSales([]); setPayments([]); setDebtAdjustments([]); setSalePayments([]); setStaffNames({}); setCurrentBalance(null); setCustomerName('');
      return;
    }

    setLoading(true);
    const customerResult = await supabase
      .from('customers')
      .select('name,balance')
      .eq('id', customerId)
      .maybeSingle();

    const name = customerResult.data?.name || '';
    setCustomerName(name);

    async function fetchSaleRows(includeSettled: boolean) {
      const byId = supabase
        .from('sales')
        .select('*, sale_items(*)')
        .eq('customer_id', customerId)
        .in('payment_method', ['credit','split'])
        .order('created_at', { ascending: false })
        .range(0, 9999);

      let primary = await byId;
      if (primary.error && /deleted_at|settled_at|schema cache|column/i.test(primary.error.message || '')) {
        primary = await supabase
          .from('sales')
          .select('*, sale_items(*)')
          .eq('customer_id', customerId)
          .in('payment_method', ['credit','split'])
          .order('created_at', { ascending: false });
      }

      let rows = (primary.data || []) as SaleWithItems[];
      // Eski sürümlerde müşteri_id yazılmadan yalnızca müşteri adı kaydedilmiş olabilir.
      if (name) {
        const legacy = await supabase
          .from('sales')
          .select('*, sale_items(*)')
          .eq('customer_name', name)
          .in('payment_method', ['credit','split'])
          .order('created_at', { ascending: false })
          .range(0, 9999);
        if (!legacy.error) {
          const merged = [...rows, ...((legacy.data || []) as SaleWithItems[])];
          const seen = new Set<string>();
          rows = merged.filter((x) => !seen.has(x.id) && seen.add(x.id));
        }
      }

      rows.sort((a:any,b:any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      if (!includeSettled) {
        rows = rows.filter((sale: any) => sale.settled_at == null);
      } else {
        rows = rows.filter((sale: any) => sale.settled_at != null);
      }
      return rows;
    }

    const [activeSales, settledSales, paymentResult, debtAdjustmentResult] = await Promise.all([
      fetchSaleRows(false),
      fetchSaleRows(true),
      supabase.from('customer_payments').select('*').eq('customer_id', customerId).order('created_at', { ascending: false }).range(0, 9999),
      supabase.from('customer_debt_adjustments').select('*').eq('customer_id', customerId).order('created_at', { ascending: false }).range(0, 9999),
    ]);

    const allSales = [...activeSales, ...settledSales];
    const saleIds = allSales.map((sale) => sale.id);
    let salePaymentRows: SalePayment[] = [];
    if (saleIds.length) {
      const paymentQuery = await supabase.from('sale_payments').select('*').in('sale_id', saleIds).order('created_at', { ascending: true });
      if (!paymentQuery.error) salePaymentRows = (paymentQuery.data || []) as SalePayment[];
    }
    const staffIds = Array.from(new Set([
      ...((paymentResult.data || []) as any[]).map((p) => p.staff_id).filter(Boolean),
      ...((debtAdjustmentResult.data || []) as any[]).map((p) => p.staff_id).filter(Boolean),
      ...allSales.map((s: any) => s.staff_id).filter(Boolean),
    ]));
    let staffMap: Record<string, string> = {};
    if (staffIds.length) {
      const staffQuery = await supabase.from('staff').select('id,name').in('id', staffIds);
      if (!staffQuery.error) staffMap = Object.fromEntries((staffQuery.data || []).map((row: any) => [row.id, row.name]));
    }

    const paymentsBySale = salePaymentRows.reduce((acc: Record<string, SalePayment[]>, row) => {
      (acc[row.sale_id] ||= []).push(row);
      return acc;
    }, {});
    const attachPayments = (rows: SaleWithItems[]) => rows.map((row: any) => ({ ...row, sale_payments: paymentsBySale[row.id] || [] }));
    setSales(attachPayments(activeSales));
    setArchiveSales(attachPayments(settledSales));
    setPayments((paymentResult.data || []) as CustomerPayment[]);
    setDebtAdjustments((debtAdjustmentResult.data || []) as CustomerDebtAdjustment[]);
    setSalePayments(salePaymentRows);
    setStaffNames(staffMap);
    setCurrentBalance(customerResult.data ? Number(customerResult.data.balance || 0) : null);
    setLoading(false);
  }, [customerId]);

  useEffect(() => {
    load();
    if (!customerId) return;
    const channel = supabase
      .channel(`customer-debt-${customerId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sales', filter: `customer_id=eq.${customerId}` }, () => load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'customer_payments', filter: `customer_id=eq.${customerId}` }, () => load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'customer_debt_adjustments', filter: `customer_id=eq.${customerId}` }, () => load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'customers', filter: `id=eq.${customerId}` }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [customerId, load]);

  return { sales, archiveSales, payments, debtAdjustments, salePayments, staffNames, currentBalance, customerName, loading, reload: load };
}



// ===== Kasa Oturumları =====

export function useActiveCashSession() {
  const [session, setSession] = useState<CashSession | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('cash_sessions')
      .select('*')
      .eq('status', 'open')
      .order('opened_at', { ascending: false })
      .maybeSingle();
    if (error) {
      console.error('Kasa oturumu yüklenemedi:', error);
    }
    setSession(data || null);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    const channel = supabase
      .channel('cash-sessions-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'cash_sessions' }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [load]);

  return { session, loading, reload: load };
}

export async function openCashSession(openingAmount: number, note?: string): Promise<CashSession | null> {
  const safeAmount = Number(openingAmount);
  if (!Number.isFinite(safeAmount) || safeAmount < 0) {
    console.error('Kasa açılamadı: geçersiz açılış tutarı.');
    return null;
  }

  // Tek bir aktif kasa olmalı. Önce mevcut açık oturumu kontrol et;
  // böylece butona art arda basılması yeni oturumlar oluşturmaz.
  const { data: existing, error: existingError } = await supabase
    .from('cash_sessions')
    .select('*')
    .eq('status', 'open')
    .order('opened_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!existingError && existing) {
    return existing as CashSession;
  }

  const { data, error } = await supabase
    .from('cash_sessions')
    .insert({
      opening_amount: safeAmount,
      status: 'open',
      note: note?.trim() || null,
    })
    .select()
    .single();

  if (error) {
    // Veritabanındaki unique index eşzamanlı ikinci açılışı engeller.
    // Böyle bir durumda mevcut aktif kasayı döndürerek kullanıcıyı mağdur etmeyelim.
    if (error.code === '23505') {
      const { data: active } = await supabase
        .from('cash_sessions')
        .select('*')
        .eq('status', 'open')
        .order('opened_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (active) return active as CashSession;
    }
    console.error('Kasa açılamadı:', error);
    return null;
  }

  await writeAudit('cash_opened', 'cash_session', data.id, { opening_amount: safeAmount, note: note?.trim() || null });
  return data as CashSession;
}

export type CashWithdrawal = { id?: string; amount: number; note?: string; created_at: string; canceled?: boolean; category?: string; exchange_id?: string };
export type CashDeposit = { id?: string; amount: number; note?: string; created_at: string; canceled?: boolean };
export type ShopExpense = { type: 'cash' | 'product'; amount: number; note?: string; product_id?: string; product_name?: string; quantity?: number; created_at: string };

const WITHDRAWAL_PREFIX = '[PARA_ALMA]';
const DEPOSIT_PREFIX = '[PARA_EKLE]';
const EXPENSE_PREFIX = '[DUKKAN_GIDERI]';

// Older 4.4.1 builds could store literal backslash+n separators.
// Normalize both actual and legacy separators so the current cash session remains readable.
function splitCashNote(note?: string | null): string[] {
  if (!note) return [];
  return note.replace(/\\+n/g, '\n').split(/\r?\n/);
}

export function getCashWithdrawals(note?: string | null): CashWithdrawal[] {
  if (!note) return [];
  return splitCashNote(note).flatMap((line) => {
    if (!line.startsWith(WITHDRAWAL_PREFIX)) return [];
    try {
      const value = JSON.parse(line.slice(WITHDRAWAL_PREFIX.length));
      if (!value || typeof value.amount !== 'number' || value.canceled === true) return [];
      return [{ id: value.id || undefined, amount: value.amount, note: value.note || undefined, created_at: value.created_at || '', canceled: false, category: value.category || undefined, exchange_id: value.exchange_id || undefined }];
    } catch { return []; }
  });
}

export function getCashDeposits(note?: string | null): CashDeposit[] {
  if (!note) return [];
  return splitCashNote(note).flatMap((line) => {
    if (!line.startsWith(DEPOSIT_PREFIX)) return [];
    try {
      const value = JSON.parse(line.slice(DEPOSIT_PREFIX.length));
      if (!value || typeof value.amount !== 'number' || value.canceled === true) return [];
      return [{ id: value.id || undefined, amount: value.amount, note: value.note || undefined, created_at: value.created_at || '', canceled: false }];
    } catch { return []; }
  });
}

export type CashIbanExchange = { id:string; business_id:string|null; cash_session_id:string; staff_id:string|null; customer_name:string|null; customer_phone:string|null; amount:number; status:'pending'|'received'|'cancelled'; note:string|null; created_at:string; received_at:string|null; cancelled_at:string|null; cancellation_reason:string|null };

export function useCashIbanExchanges(cashSessionId?: string | null) {
  const [rows,setRows]=useState<CashIbanExchange[]>([]);
  const load=useCallback(async()=>{
    if(!cashSessionId){ setRows([]); return; }
    const {data,error}=await supabase.from('cash_iban_exchanges').select('*').eq('cash_session_id',cashSessionId).order('created_at',{ascending:false});
    if(error) console.error('IBAN işlemleri yüklenemedi:',error);
    setRows((data||[]) as CashIbanExchange[]);
  },[cashSessionId]);
  useEffect(()=>{ load(); },[load]);
  return {rows,reload:load};
}

async function resolveRemoteStaffId(preferredId?: string | null): Promise<string | null> {
  try {
    if (preferredId) {
      const { data } = await supabase.from('staff').select('id').eq('id', preferredId).eq('active', true).maybeSingle();
      if (data?.id) return data.id;
    }
    const raw = sessionStorage.getItem('propos-current-staff-v2');
    const saved = raw ? JSON.parse(raw) as { id?: string; name?: string } : null;
    if (saved?.id) {
      const { data } = await supabase.from('staff').select('id').eq('id', saved.id).eq('active', true).maybeSingle();
      if (data?.id) return data.id;
    }
    if (saved?.name) {
      const exact = await supabase.from('staff').select('id').eq('active', true).ilike('name', saved.name).limit(1).maybeSingle();
      if (exact.data?.id) return exact.data.id;
      const partial = await supabase.from('staff').select('id').eq('active', true).ilike('name', `%${saved.name}%`).limit(1).maybeSingle();
      if (partial.data?.id) return partial.data.id;
    }
  } catch (err) {
    console.error('Aktif personel çözümlenemedi:', err);
  }
  return null;
}

export async function cancelCashManualEntry(cashSessionId:string, entryId:string, entryKind:'deposit'|'withdrawal'|'customer_iban', staffId?:string|null, reason?:string):Promise<boolean>{
  const resolvedStaffId = await resolveRemoteStaffId(staffId);
  if(!resolvedStaffId) return false;
  const {data,error}=await supabase.rpc('cancel_cash_manual_entry',{p_cash_session_id:cashSessionId,p_entry_id:entryId,p_entry_kind:entryKind,p_staff_id:resolvedStaffId,p_reason:reason?.trim()||null});
  if(error){ console.error('Kasa hareketi iptal edilemedi:',error); return false; }
  if(data===true) await writeAudit('cash_entry_cancelled','cash_session',cashSessionId,{entry_id:entryId,entry_kind:entryKind,reason:reason||null});
  return data===true;
}

export async function createCashIbanExchange(cashSessionId:string, amount:number, customerName?:string, customerPhone?:string, note?:string, staffId?:string|null){
  const resolvedStaffId = await resolveRemoteStaffId(staffId);
  if(!resolvedStaffId || !Number.isFinite(amount) || amount<=0) return {data:null,error:'Geçersiz IBAN işlemi'};
  const {data,error}=await supabase.rpc('create_cash_iban_exchange',{p_cash_session_id:cashSessionId,p_amount:amount,p_customer_name:customerName?.trim()||null,p_customer_phone:customerPhone?.trim()||null,p_note:note?.trim()||null,p_staff_id:resolvedStaffId});
  if(error){ console.error('Müşteri nakit/IBAN işlemi kaydedilemedi:',error); return {data:null,error:error.message||'İşlem kaydedilemedi'}; }
  await writeAudit('customer_iban_created','cash_session',cashSessionId,{amount,customer_name:customerName||null,customer_phone:customerPhone||null,note:note||null});
  return {data,error:null};
}

export async function markCashIbanReceived(exchangeId:string, staffId?:string|null):Promise<boolean>{
  const resolvedStaffId = await resolveRemoteStaffId(staffId);
  if(!resolvedStaffId) return false;
  const {data,error}=await supabase.rpc('mark_cash_iban_received',{p_exchange_id:exchangeId,p_staff_id:resolvedStaffId});
  if(error){ console.error('IBAN transferi tamamlanamadı:',error); return false; }
  if(data===true) await writeAudit('customer_iban_received','cash_iban_exchange',exchangeId);
  return data===true;
}


export type SupplierCashPayment = { amount:number; supplier_id?:string; payment_id?:string; note?:string; created_at:string };
const SUPPLIER_PAYMENT_PREFIX = '[TEDARIKCI_ODEME]';

export function getSupplierCashPayments(note?: string | null): SupplierCashPayment[] {
  if (!note) return [];
  return splitCashNote(note).flatMap((line) => {
    if (!line.startsWith(SUPPLIER_PAYMENT_PREFIX)) return [];
    try {
      const value = JSON.parse(line.slice(SUPPLIER_PAYMENT_PREFIX.length));
      if (!value || typeof value.amount !== 'number') return [];
      return [{ amount:value.amount, supplier_id:value.supplier_id || undefined, payment_id:value.payment_id || undefined, note:value.note || undefined, created_at:value.created_at || '' }];
    } catch { return []; }
  });
}

export type CashRefund = { amount: number; reason?: string; sale_id?: string; created_at: string };
const CASH_REFUND_PREFIX = '[PARA_CIKISI_Iade]';

export function getCashRefunds(note?: string | null): CashRefund[] {
  if (!note) return [];
  return splitCashNote(note).flatMap((line) => {
    if (!line.startsWith(CASH_REFUND_PREFIX)) return [];
    try {
      const value = JSON.parse(line.slice(CASH_REFUND_PREFIX.length));
      if (!value || typeof value.amount !== 'number') return [];
      return [{ amount: value.amount, reason: value.reason || undefined, sale_id: value.sale_id || undefined, created_at: value.created_at || '' }];
    } catch { return []; }
  });
}

export function getShopExpenses(note?: string | null): ShopExpense[] {
  if (!note) return [];
  return splitCashNote(note).flatMap((line) => {
    if (!line.startsWith(EXPENSE_PREFIX)) return [];
    try {
      const value = JSON.parse(line.slice(EXPENSE_PREFIX.length));
      if (!value || (value.type !== 'cash' && value.type !== 'product') || typeof value.amount !== 'number') return [];
      return [{
        type: value.type,
        amount: value.amount,
        note: value.note || undefined,
        product_id: value.product_id || undefined,
        product_name: value.product_name || undefined,
        quantity: typeof value.quantity === 'number' ? value.quantity : undefined,
        created_at: value.created_at || '',
      } as ShopExpense];
    } catch {
      return [];
    }
  });
}

export async function addShopCashExpense(id: string, amount: number, note?: string): Promise<boolean> {
  if (!Number.isFinite(amount) || amount <= 0) return false;
  const { data: session, error: readError } = await supabase.from('cash_sessions').select('note, status').eq('id', id).single();
  if (readError || !session || session.status !== 'open') return false;
  const entry = `${EXPENSE_PREFIX}${JSON.stringify({ type: 'cash', amount, note: note?.trim() || undefined, created_at: new Date().toISOString() })}`;
  const nextNote = [session.note || '', entry].filter(Boolean).join('\n');
  const { error } = await supabase.from('cash_sessions').update({ note: nextNote }).eq('id', id);
  if (error) { console.error('Dükkan gideri kaydedilemedi:', error); return false; }
  return true;
}

export async function addShopProductExpense(id: string, product: Product, quantity: number, note?: string): Promise<boolean> {
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > product.stock) return false;
  const { data: session, error: readError } = await supabase.from('cash_sessions').select('note, status').eq('id', id).single();
  if (readError || !session || session.status !== 'open') return false;
  const { data: currentProduct, error: productReadError } = await supabase.from('products').select('stock, name, cost').eq('id', product.id).single();
  if (productReadError || !currentProduct || Number(currentProduct.stock) < quantity) return false;
  const costAmount = Number(currentProduct.cost || 0) * quantity;
  const { error: stockError } = await supabase.from('products').update({ stock: Number(currentProduct.stock) - quantity }).eq('id', product.id);
  if (stockError) { console.error('Gider için stok düşülemedi:', stockError); return false; }
  const entry = `${EXPENSE_PREFIX}${JSON.stringify({ type: 'product', amount: costAmount, quantity, product_id: product.id, product_name: currentProduct.name, note: note?.trim() || undefined, created_at: new Date().toISOString() })}`;
  const nextNote = [session.note || '', entry].filter(Boolean).join('\n');
  const { error } = await supabase.from('cash_sessions').update({ note: nextNote }).eq('id', id);
  if (error) {
    await supabase.from('products').update({ stock: Number(currentProduct.stock) }).eq('id', product.id);
    console.error('Ürün gideri kaydedilemedi:', error);
    return false;
  }
  return true;
}

export async function addCashDeposit(id: string, amount: number, note?: string): Promise<boolean> {
  if (!Number.isFinite(amount) || amount <= 0) return false;
  const staffId = await resolveRemoteStaffId();
  if (!staffId) { console.error('Kasaya para eklenemedi: aktif admin/müdür personeli bulunamadı.'); return false; }
  const { data, error } = await supabase.rpc('add_cash_manual_entry', { p_cash_session_id:id, p_amount:amount, p_kind:'deposit', p_staff_id:staffId, p_note:note?.trim()||null });
  if (error || data !== true) { console.error('Kasaya para eklenemedi:', error); return false; }
  await writeAudit('cash_deposit','cash_session',id,{amount,note:note||null});
  return true;
}

export async function addCashWithdrawal(id: string, amount: number, note?: string): Promise<boolean> {
  if (!Number.isFinite(amount) || amount <= 0) return false;
  const staffId = await resolveRemoteStaffId();
  if (!staffId) { console.error('Kasadan para alınamadı: aktif admin/müdür personeli bulunamadı.'); return false; }
  const { data, error } = await supabase.rpc('add_cash_manual_entry', { p_cash_session_id:id, p_amount:amount, p_kind:'withdrawal', p_staff_id:staffId, p_note:note?.trim()||null });
  if (error || data !== true) { console.error('Kasadan para alınamadı:', error); return false; }
  await writeAudit('cash_withdrawal','cash_session',id,{amount,note:note||null});
  return true;
}

export async function closeCashSession(id: string, closingAmount: number, note?: string): Promise<boolean> {
  const { data: current, error: readError } = await supabase
    .from('cash_sessions')
    .select('note')
    .eq('id', id)
    .single();
  if (readError) {
    console.error('Kasa notu okunamadı:', readError);
    return false;
  }
  const baseNote = (current?.note || '').split('\n').filter((line: string) => !line.startsWith('[KAPANIS_NOTU]')).join('\n').trim();
  const nextNote = [baseNote, note?.trim() ? `[KAPANIS_NOTU]${note.trim()}` : ''].filter(Boolean).join('\n');
  const { error } = await supabase
    .from('cash_sessions')
    .update({
      closing_amount: closingAmount,
      status: 'closed',
      closed_at: new Date().toISOString(),
      note: nextNote || null,
    })
    .eq('id', id);
  if (error) {
    console.error('Kasa kapatılamadı:', error);
    return false;
  }
  return true;
}

export type CashReconciliationInput = {
  sessionId: string;
  countedCash: number;
  expectedCash: number;
  cashSales: number;
  cardSales: number;
  creditSales: number;
  deposits: number;
  withdrawals: number;
  supplierCashPayments: number;
  shopCashExpenses: number;
  cashRefunds: number;
  saleCount: number;
  staffId?: string | null;
  note?: string;
};

export async function closeCashSessionReconciled(input: CashReconciliationInput): Promise<{success:boolean; error?:string; difference?:number}> {
  const { data, error } = await supabase.rpc('close_cash_session_reconciled', {
    p_session_id: input.sessionId,
    p_counted_cash: input.countedCash,
    p_expected_cash: input.expectedCash,
    p_cash_sales: input.cashSales,
    p_card_sales: input.cardSales,
    p_credit_sales: input.creditSales,
    p_deposits: input.deposits,
    p_withdrawals: input.withdrawals,
    p_supplier_cash_payments: input.supplierCashPayments,
    p_shop_cash_expenses: input.shopCashExpenses,
    p_cash_refunds: input.cashRefunds,
    p_sale_count: input.saleCount,
    p_staff_id: input.staffId || null,
    p_note: input.note?.trim() || null,
  });
  if (error) {
    console.error('Kasa mutabakatı kaydedilemedi:', error);
    return { success:false, error:error.message };
  }
  return { success:true, difference:Number(data?.difference || 0) };
}

export function useCashSessions(limit = 30) {
  const [sessions, setSessions] = useState<CashSession[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('cash_sessions')
      .select('*')
      .order('opened_at', { ascending: false })
      .limit(limit);
    if (error) {
      console.error('Kasa oturumları yüklenemedi:', error);
    }
    setSessions(data || []);
    setLoading(false);
  }, [limit]);

  useEffect(() => {
    load();
    const channel = supabase
      .channel('cash-sessions-list-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'cash_sessions' }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [load]);

  return { sessions, loading, reload: load };
}

export async function getSaleItems(saleId: string): Promise<SaleItem[]> {
  const { data, error } = await supabase
    .from('sale_items')
    .select('*')
    .eq('sale_id', saleId);
  if (error) {
    console.error('Satış kalemleri yüklenemedi:', error);
    return [];
  }
  return data || [];
}

export function useSalesByDate(startDate: string, endDate: string) {
  const [sales, setSales] = useState<Sale[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    let { data, error } = await supabase
      .from('sales')
      .select('*')
      .gte('created_at', startDate)
      .lte('created_at', endDate)
      .is('deleted_at', null)
      .order('created_at', { ascending: false });

    if (error && /deleted_at|schema cache|column/i.test(error.message || '')) {
      const fallback = await supabase
        .from('sales')
        .select('*')
        .gte('created_at', startDate)
        .lte('created_at', endDate)
        .order('created_at', { ascending: false });
      data = fallback.data;
      error = fallback.error;
    }

    if (error) {
      console.error('Satışlar yüklenemedi:', error);
    }
    setSales((data || []) as Sale[]);
    setLoading(false);
  }, [startDate, endDate]);

  useEffect(() => {
    load();
  }, [load]);

  return { sales, loading, reload: load };
}


// ===== Rapor / Satış Çöp Kutusu =====
// Satışı fiziksel olarak silmez. Stok ve veresiye bakiyesini güvenli şekilde geri alır.
export async function moveSaleToTrash(id: string, reason = 'Kullanıcı tarafından iptal edildi'): Promise<boolean> {
  // Idempotent transaction: if the sale is already in the trash, treat it as success.
  const { data: rpcData, error: rpcError } = await supabase.rpc('move_sale_to_trash_v2', {
    p_sale_id: id,
    p_reason: reason,
  });

  if (!rpcError && rpcData === true) { await writeAudit('sale_trashed', 'sale', id, { reason }); return true; }

  // Some Supabase projects cache the RPC schema for a short time. If the RPC
  // is unavailable, verify whether a previous attempt already moved the sale.
  const { data: currentSale, error: currentSaleError } = await supabase
    .from('sales')
    .select('id, deleted_at')
    .eq('id', id)
    .maybeSingle();

  if (!currentSaleError && currentSale?.deleted_at) return true;

  // Safe fallback for projects where the new RPC is not yet visible.
  // Do not touch stock unless the sale itself can be marked as deleted.
  const deletedAt = new Date().toISOString();
  const { data: moved, error: moveError } = await supabase
    .from('sales')
    .update({ deleted_at: deletedAt, deleted_reason: reason })
    .eq('id', id)
    .is('deleted_at', null)
    .select('id, deleted_at')
    .maybeSingle();

  if (moveError || !moved?.deleted_at) {
    console.error('Satış çöp kutusuna taşınamadı:', { rpcError, rpcData, moveError });
    return false;
  }

  // Once the sale is marked deleted, restore the stock/cari movement.
  // If a product update fails, leave the sale in the trash rather than
  // reporting a false success; the user can retry the operation.
  const { data: items, error: itemsError } = await supabase
    .from('sale_items')
    .select('product_id, quantity')
    .eq('sale_id', id);

  if (itemsError) {
    console.error('Satış kalemleri okunamadı:', itemsError);
    return false;
  }

  for (const item of items || []) {
    if (!item.product_id) continue;
    const { data: product, error: productError } = await supabase
      .from('products')
      .select('stock')
      .eq('id', item.product_id)
      .maybeSingle();
    if (productError || !product) {
      console.error('Stok okunamadı:', productError);
      return false;
    }

    const { error: stockError } = await supabase
      .from('products')
      .update({ stock: Number(product.stock || 0) + Number(item.quantity || 0) })
      .eq('id', item.product_id);
    if (stockError) {
      console.error('Stok geri alınamadı:', stockError);
      return false;
    }
  }

  return true;
}

export async function restoreSaleFromTrash(id: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('restore_sale_from_trash', {
    p_sale_id: id,
  });
  if (!error) return data === true;

  console.error('Satış RPC ile geri yüklenemedi, yedek yöntem deneniyor:', error);
  const { data: sale } = await supabase.from('sales').select('*').eq('id', id).maybeSingle();
  if (!sale || !sale.deleted_at) return false;
  const { data: items, error: itemsError } = await supabase
    .from('sale_items').select('product_id, quantity').eq('sale_id', id);
  if (itemsError) return false;
  for (const item of items || []) {
    if (!item.product_id) continue;
    const { data: product } = await supabase.from('products').select('stock').eq('id', item.product_id).maybeSingle();
    if (!product) return false;
    const { error: stockError } = await supabase.from('products')
      .update({ stock: Number(product.stock || 0) - Number(item.quantity || 0) }).eq('id', item.product_id);
    if (stockError) return false;
  }
  if (sale.payment_method === 'credit' && sale.customer_id) {
    const { data: customer } = await supabase.from('customers').select('balance').eq('id', sale.customer_id).maybeSingle();
    if (customer) await supabase.from('customers').update({ balance: Number(customer.balance || 0) + Number(sale.total || 0) }).eq('id', sale.customer_id);
  }
  const { error: restoreError } = await supabase.from('sales').update({ deleted_at: null, deleted_reason: null }).eq('id', id);
  return !restoreError;
}

export async function refundSale(id: string, reason = 'Müşteri iadesi'): Promise<boolean> {
  // İade, temel POS şemasıyla çalışır; sonradan eklenen çöp kutusu/iade
  // kolonları yoksa da işlemi engellemez.
  const { data: sale, error: saleError } = await supabase
    .from('sales')
    .select('id, total, payment_method, customer_name, paid_amount, created_at')
    .eq('id', id)
    .maybeSingle();

  if (saleError || !sale) {
    console.error('İade için satış okunamadı:', saleError);
    return false;
  }

  // İade edilmiş olup olmadığını, varsa işaret alanından kontrol et.
  let existingReason = '';
  const { data: statusRow } = await supabase
    .from('sales')
    .select('deleted_reason')
    .eq('id', id)
    .maybeSingle();
  if (statusRow?.deleted_reason) existingReason = String(statusRow.deleted_reason);
  if (existingReason.startsWith('İADE|')) return true;

  // Satış kalemleri yalnızca temel şema alanlarıyla okunur.
  const { data: items, error: itemsError } = await supabase
    .from('sale_items')
    .select('product_id, quantity, barcode, product_name')
    .eq('sale_id', id);

  if (itemsError || !items || items.length === 0) {
    console.error('İade ürünleri okunamadı:', itemsError);
    return false;
  }

  const quantities = new Map<string, number>();
  for (const item of items) {
    let productId = item.product_id as string | null;

    if (!productId && item.barcode) {
      const { data: byBarcode } = await supabase
        .from('products').select('id').eq('barcode', item.barcode).maybeSingle();
      productId = byBarcode?.id || null;
    }
    if (!productId && item.product_name) {
      const { data: byName } = await supabase
        .from('products').select('id').eq('name', item.product_name).maybeSingle();
      productId = byName?.id || null;
    }
    if (!productId) {
      console.error('İade ürünü bulunamadı:', item);
      return false;
    }
    quantities.set(productId, (quantities.get(productId) || 0) + Number(item.quantity || 0));
  }

  // Veresiye satışsa customer_id varsa bakiyeyi geri al.
  let customerId: string | null = null;
  let previousBalance: number | null = null;
  if (sale.payment_method === 'credit') {
    const { data: creditSale } = await supabase
      .from('sales').select('customer_id').eq('id', id).maybeSingle();
    customerId = creditSale?.customer_id || null;
    if (customerId) {
      const { data: customer, error: customerError } = await supabase
        .from('customers').select('balance').eq('id', customerId).maybeSingle();
      if (customerError || !customer) {
        console.error('İade müşteri bakiyesi okunamadı:', customerError);
        return false;
      }
      previousBalance = Number(customer.balance || 0);
    }
  }

  const previousStocks = new Map<string, number>();
  for (const [productId] of quantities) {
    const { data: product, error: productError } = await supabase
      .from('products').select('stock').eq('id', productId).maybeSingle();
    if (productError || !product) {
      console.error('İade ürünü okunamadı:', { productId, productError });
      return false;
    }
    previousStocks.set(productId, Number(product.stock || 0));
  }

  const updatedProducts: string[] = [];
  let balanceUpdated = false;
  try {
    for (const [productId, quantity] of quantities) {
      const { error } = await supabase.from('products')
        .update({ stock: (previousStocks.get(productId) || 0) + quantity })
        .eq('id', productId);
      if (error) throw error;
      updatedProducts.push(productId);
    }

    if (customerId && previousBalance !== null) {
      const { error } = await supabase.from('customers')
        .update({ balance: Math.max(0, previousBalance - Number(sale.total || 0)) })
        .eq('id', customerId);
      if (error) throw error;
      balanceUpdated = true;
    }

    // Önce mevcut iade/çöp kutusu kolonları varsa satış kaydını koruyarak işaretle.
    const marker = `İADE|${new Date().toISOString()}|${Number(sale.total || 0)}|${reason || 'Müşteri iadesi'}`;
    let marked = false;

    const withTrashColumns = await supabase.from('sales')
      .update({ deleted_reason: marker, deleted_at: null })
      .eq('id', id)
      .select('id')
      .maybeSingle();
    if (!withTrashColumns.error && withTrashColumns.data) {
      marked = true;
    } else {
      const reasonOnly = await supabase.from('sales')
        .update({ deleted_reason: marker })
        .eq('id', id)
        .select('id')
        .maybeSingle();
      if (!reasonOnly.error && reasonOnly.data) marked = true;
    }

    // Eski veritabanında deleted_reason/deleted_at yoksa satış kaydını silerek
    // iade işlemini tamamla. Stok ve cari hareketi zaten geri alınmış durumda.
    if (!marked) {
      const { error: deleteError } = await supabase.from('sales').delete().eq('id', id);
      if (deleteError) throw deleteError;
    }

    await writeAudit('sale_refunded', 'sale', id, { total: Number(sale.total || 0), reason });
    return true;
  } catch (error) {
    console.error('İade işlemi sırasında hata:', error);
    for (const productId of updatedProducts) {
      await supabase.from('products')
        .update({ stock: previousStocks.get(productId) || 0 }).eq('id', productId);
    }
    if (balanceUpdated && customerId && previousBalance !== null) {
      await supabase.from('customers').update({ balance: previousBalance }).eq('id', customerId);
    }
    return false;
  }
}

export async function permanentlyDeleteSale(id: string): Promise<boolean> {
  const { error } = await supabase
    .from('sales')
    .delete()
    .eq('id', id);
  if (error) {
    console.error('Satış kalıcı olarak silinemedi:', error);
    return false;
  }
  return true;
}

export function useDeletedSales(limit = 200) {
  const [sales, setSales] = useState<Sale[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('sales')
      .select('*')
      .not('deleted_at', 'is', null)
      .order('deleted_at', { ascending: false })
      .limit(limit);
    if (error) {
      console.error('Çöp kutusu yüklenemedi:', error);
    }
    setSales(data || []);
    setLoading(false);
  }, [limit]);

  useEffect(() => {
    load();
    const channel = supabase
      .channel('deleted-sales-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sales' }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [load]);

  return { sales, loading, reload: load };
}


// ===== Alış & Tedarikçiler =====
export function useSuppliers() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.from('suppliers').select('*').order('name');
    if (error) console.error('Tedarikçiler yüklenemedi:', error);
    setSuppliers((data || []) as Supplier[]);
    setLoading(false);
  }, []);
  useEffect(() => {
    load();
    const ch = supabase.channel('suppliers-changes').on('postgres_changes', { event:'*', schema:'public', table:'suppliers' }, () => load()).subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [load]);
  return { suppliers, loading, reload: load };
}

export async function saveSupplier(input: Partial<Supplier> & { name: string }): Promise<Supplier | null> {
  let businessId: string | null = null;
  try {
    const { data: business } = await supabase.from('businesses').select('id').eq('active', true).order('created_at', { ascending: true }).limit(1).maybeSingle();
    businessId = (business?.id as string | undefined) || null;
  } catch {}
  const payload = {
    business_id: businessId,
    name: input.name.trim(),
    contact_name: input.contact_name?.trim() || null,
    phone: input.phone?.trim() || null,
    address: input.address?.trim() || null,
    note: input.note?.trim() || null,
    active: input.active ?? true,
    updated_at: new Date().toISOString(),
  };
  if (!payload.name) return null;
  let result;
  if (input.id) result = await supabase.from('suppliers').update(payload).eq('id', input.id).select().single();
  else result = await supabase.from('suppliers').insert(payload).select().single();
  if (result.error || !result.data) {
    console.error('Tedarikçi kaydedilemedi:', result.error);
    return null;
  }
  await writeAudit(input.id ? 'supplier_updated' : 'supplier_created', 'supplier', result.data.id, { name: payload.name });
  return result.data as Supplier;
}

export async function toggleSupplier(id: string, active: boolean): Promise<boolean> {
  const { error } = await supabase.from('suppliers').update({ active, updated_at: new Date().toISOString() }).eq('id', id);
  return !error;
}

export function usePurchaseReceipts(limit = 100) {
  const [rows, setRows] = useState<PurchaseReceipt[]>([]);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.from('purchase_receipts').select('*').order('purchase_date', { ascending:false }).limit(limit);
    if (error) console.error('Alış kayıtları yüklenemedi:', error);
    setRows((data || []) as PurchaseReceipt[]);
    setLoading(false);
  }, [limit]);
  useEffect(() => {
    load();
    const ch = supabase.channel('purchase-receipts-changes').on('postgres_changes', { event:'*', schema:'public', table:'purchase_receipts' }, () => load()).subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [load]);
  return { receipts: rows, loading, reload: load };
}

export async function receivePurchase(input: {
  supplierId: string | null;
  invoiceNo?: string;
  purchaseDate?: string;
  discountTotal?: number;
  staffId: string | null;
  notes?: string;
  items: Array<{ productId: string; productName: string; barcode?: string | null; quantity: number; unitCost: number }>;
}): Promise<{ success:boolean; id?:string; error?:string }> {
  if (!input.items.length) return { success:false, error:'Alış için en az bir ürün gerekli.' };
  const cleanItems = input.items.map(x => ({ productId:x.productId, productName:x.productName, barcode:x.barcode || null, quantity:Number(x.quantity), unitCost:Number(x.unitCost) }));
  if (cleanItems.some(x => !x.productId || x.quantity <= 0 || !Number.isFinite(x.quantity) || x.unitCost < 0 || !Number.isFinite(x.unitCost))) {
    return { success:false, error:'Alış kalemlerinde geçersiz değer var.' };
  }
  const { data, error } = await supabase.rpc('receive_purchase_atomic', {
    p_supplier_id: input.supplierId || null,
    p_invoice_no: input.invoiceNo?.trim() || null,
    p_purchase_date: input.purchaseDate || new Date().toISOString(),
    p_discount_total: Number(input.discountTotal || 0),
    p_staff_id: input.staffId || null,
    p_items: cleanItems,
    p_notes: input.notes?.trim() || null,
  });
  if (error) {
    console.error('Alış kaydedilemedi:', error);
    return { success:false, error:error.message || 'Alış kaydedilemedi.' };
  }
  await writeAudit('purchase_received', 'purchase_receipt', String(data), { supplier_id: input.supplierId, item_count: cleanItems.length });
  return { success:true, id:String(data) };
}

export async function loadPurchaseItems(receiptId: string): Promise<PurchaseReceiptItem[]> {
  const { data, error } = await supabase.from('purchase_receipt_items').select('*').eq('purchase_receipt_id', receiptId).order('created_at');
  if (error) { console.error('Alış kalemleri yüklenemedi:', error); return []; }
  return (data || []) as PurchaseReceiptItem[];
}

export function useSupplierAccounts() {
  const [accounts, setAccounts] = useState<SupplierAccount[]>([]);
  const [payments, setPayments] = useState<SupplierPayment[]>([]);
  const [receipts, setReceipts] = useState<PurchaseReceipt[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data: suppliersData, error: suppliersError }, { data: receiptsData, error: receiptsError }, { data: paymentsData, error: paymentsError }] = await Promise.all([
      supabase.from('suppliers').select('*').order('name'),
      supabase.from('purchase_receipts').select('*').not('supplier_id', 'is', null).order('purchase_date', { ascending: false }),
      supabase.from('supplier_payments').select('*').order('created_at', { ascending: false }),
    ]);
    if (suppliersError) console.error('Tedarikçiler yüklenemedi:', suppliersError);
    if (receiptsError) console.error('Tedarikçi alışları yüklenemedi:', receiptsError);
    if (paymentsError) console.error('Tedarikçi ödemeleri yüklenemedi:', paymentsError);
    const nextSuppliers = (suppliersData || []) as Supplier[];
    const nextReceipts = (receiptsData || []) as PurchaseReceipt[];
    const nextPayments = (paymentsData || []) as SupplierPayment[];
    const computed = nextSuppliers.filter(s => s.active).map((supplier) => {
      const supplierReceipts = nextReceipts.filter(r => r.supplier_id === supplier.id);
      const supplierPayments = nextPayments.filter(p => p.supplier_id === supplier.id);
      const totalPurchases = supplierReceipts.reduce((sum, r) => sum + Number(r.total || 0), 0);
      const totalPaid = supplierPayments.reduce((sum, r) => sum + Number(r.amount || 0), 0);
      return {
        supplier,
        total_purchases: Number(totalPurchases.toFixed(2)),
        total_paid: Number(totalPaid.toFixed(2)),
        balance: Number(Math.max(totalPurchases - totalPaid, 0).toFixed(2)),
        purchase_count: supplierReceipts.length,
        payment_count: supplierPayments.length,
      };
    });
    setAccounts(computed);
    setPayments(nextPayments);
    setReceipts(nextReceipts);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    const channels = [
      supabase.channel('supplier-accounts-suppliers').on('postgres_changes', { event:'*', schema:'public', table:'suppliers' }, load).subscribe(),
      supabase.channel('supplier-accounts-receipts').on('postgres_changes', { event:'*', schema:'public', table:'purchase_receipts' }, load).subscribe(),
      supabase.channel('supplier-accounts-payments').on('postgres_changes', { event:'*', schema:'public', table:'supplier_payments' }, load).subscribe(),
    ];
    return () => channels.forEach(channel => { supabase.removeChannel(channel); });
  }, [load]);

  return { accounts, payments, receipts, loading, reload: load };
}

export async function paySupplier(input: {
  supplierId: string;
  amount: number;
  paymentMethod: 'cash' | 'card' | 'bank';
  note?: string;
  staffId?: string | null;
  purchaseReceiptId?: string | null;
}): Promise<{ success: boolean; id?: string; balanceAfter?: number; error?: string }> {
  if (!input.supplierId || !Number.isFinite(input.amount) || input.amount <= 0) return { success:false, error:'Geçerli bir ödeme tutarı girin.' };
  const { data, error } = await supabase.rpc('pay_supplier_atomic', {
    p_supplier_id: input.supplierId,
    p_amount: Number(input.amount),
    p_payment_method: input.paymentMethod,
    p_note: input.note?.trim() || null,
    p_staff_id: input.staffId || null,
    p_purchase_receipt_id: input.purchaseReceiptId || null,
  });
  if (error) {
    console.error('Tedarikçi ödemesi kaydedilemedi:', error);
    return { success:false, error:error.message || 'Tedarikçi ödemesi kaydedilemedi.' };
  }
  const result = (data || {}) as { id?: string; balance_after?: number };
  await writeAudit('supplier_payment', 'supplier', input.supplierId, { amount: input.amount, payment_method: input.paymentMethod, purchase_receipt_id: input.purchaseReceiptId || null });
  return { success:true, id:result.id, balanceAfter:Number(result.balance_after || 0) };
}

export function useSupplierPayments(cashSessionId?: string | null) {
  const [payments, setPayments] = useState<SupplierPayment[]>([]);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    let query = supabase.from('supplier_payments').select('*').order('created_at', { ascending:false });
    if (cashSessionId) query = query.eq('cash_session_id', cashSessionId);
    const { data, error } = await query.limit(500);
    if (error) console.error('Tedarikçi ödemeleri yüklenemedi:', error);
    setPayments((data || []) as SupplierPayment[]);
    setLoading(false);
  }, [cashSessionId]);
  useEffect(() => {
    load();
    const ch = supabase.channel(`supplier-payments-${cashSessionId || 'all'}`).on('postgres_changes', { event:'*', schema:'public', table:'supplier_payments' }, load).subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [load, cashSessionId]);
  return { payments, loading, reload: load };
}
