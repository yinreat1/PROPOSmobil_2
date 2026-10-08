import { createClient } from '@supabase/supabase-js';

// Vite normally injects these values from .env/.env.local.
// The publishable/anon key is safe to expose in a browser client, so keep a
// production fallback here as a last resort. This prevents a missing local
// env file from blank-screening the POS application.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://ukfeuojhigxxxlnhsmls.supabase.co';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'sb_publishable_b-cFhb97kOd3mLQnBi_SGQ_8oNQPkzS';

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export type Business = { id:string; name:string; phone:string|null; address:string|null; active:boolean; created_at:string; updated_at:string };

export type StoreSettings = {
  storeName: string; storeAddress: string; storePhone: string; currency: string; receiptFooter: string; taxRate: string; lowStockDefault: string;
};

export type Category = {
  id: string;
  name: string;
  sort_order: number;
  created_at: string;
  business_id?: string | null;
};

export type Product = {
  id: string;
  name: string;
  barcode: string | null;
  additional_barcodes: string[];
  price: number;
  cost: number;
  stock: number;
  min_stock: number;
  category_id: string | null;
  unit: string;
  discount_enabled: boolean;
  discount_price: number | null;
  discount_starts_at: string | null;
  discount_ends_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  business_id?: string | null;
  primary_supplier_id?: string | null;
};

export type Sale = {
  id: string;
  total: number;
  payment_method: 'cash' | 'card' | 'credit' | 'split';
  customer_name: string | null;
  customer_id: string | null;
  paid_amount: number;
  created_at: string;
  deleted_at: string | null;
  deleted_reason: string | null;
  settled_at: string | null;
  refunded_at: string | null;
  refund_amount: number | null;
  refund_reason: string | null;
  original_total: number;
  discount_total: number;
  payment_note: string | null;
  staff_id: string | null;
};

export type SaleItem = {
  id: string;
  sale_id: string;
  product_id: string | null;
  product_name: string;
  barcode: string | null;
  quantity: number;
  unit_price: number;
  subtotal: number;
  original_unit_price: number;
  discount_amount: number;
  cost_at_sale?: number | null;
  cost_is_estimated?: boolean;
};

export type SaleWithItems = Sale & {
  sale_items: SaleItem[];
};

export type Customer = {
  id: string;
  name: string;
  phone: string | null;
  balance: number;
  created_at: string;
  business_id?: string | null;
};

export type CustomerPayment = {
  id: string;
  customer_id: string;
  amount: number;
  note: string | null;
  staff_id?: string | null;
  created_at: string;
};

export type CashReconciliation = {
  id:string; business_id:string|null; cash_session_id:string; expected_cash:number; counted_cash:number; difference:number; cash_sales:number; card_sales:number; credit_sales:number; deposits:number; withdrawals:number; supplier_cash_payments:number; shop_cash_expenses:number; cash_refunds:number; sale_count:number; staff_id:string|null; note:string|null; created_at:string;
};
export type CashIbanExchange = { id:string; business_id:string|null; cash_session_id:string; staff_id:string|null; customer_name:string|null; customer_phone:string|null; amount:number; status:'pending'|'received'|'cancelled'; note:string|null; created_at:string; received_at:string|null; cancelled_at:string|null; cancellation_reason:string|null };
export type CashSession = {
  id: string;
  opening_amount: number;
  closing_amount: number | null;
  status: 'open' | 'closed';
  opened_at: string;
  closed_at: string | null;
  note: string | null;
};

export type SalePayment = { id: string; sale_id: string; method: 'cash'|'card'|'credit'; amount: number; created_at: string };
export type StockMovement = { id:string; product_id:string|null; product_name:string; movement_type:'in'|'out'|'adjustment'|'sale'|'return'|'waste'; quantity:number; before_stock:number; after_stock:number; reason:string|null; sale_id:string|null; staff_id:string|null; created_at:string };
export type Staff = { id:string; name:string; pin:string|null; pin_hash?:string|null; role:'admin'|'manager'|'cashier'; active:boolean; earning_rate:number; financial_start_at?:string; created_at:string };
export type StaffEarning = { id:string; staff_id:string; customer_payment_id:string|null; amount_paid:number; rate_percent:number; earning_amount:number; source:'customer_payment'|'sale_payment'; created_at:string };
export type StaffConsumption = { id:string; business_id:string|null; staff_id:string; product_id:string|null; product_name:string; quantity:number; unit_price:number; total_amount:number; cost_amount?:number; consumption_type:'personal'|'gift'; note:string|null; created_at:string };
export type StaffPayout = { id:string; business_id:string|null; staff_id:string; cash_session_id:string|null; amount:number; note:string|null; created_at:string };
export type Supplier = {
  id: string;
  business_id: string | null;
  name: string;
  contact_name: string | null;
  phone: string | null;
  address: string | null;
  note: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
};

export type PurchaseReceipt = {
  id: string;
  business_id: string | null;
  supplier_id: string | null;
  invoice_no: string | null;
  purchase_date: string;
  subtotal: number;
  discount_total: number;
  total: number;
  paid_amount: number;
  status: 'open' | 'paid' | 'partial';
  payment_method: 'cash' | 'card' | 'credit';
  notes: string | null;
  staff_id: string | null;
  created_at: string;
};

export type PurchaseReceiptItem = {
  id: string;
  purchase_receipt_id: string;
  product_id: string | null;
  product_name: string;
  barcode: string | null;
  quantity: number;
  unit_cost: number;
  line_total: number;
  previous_cost: number | null;
  created_at: string;
};

export type SupplierPayment = {
  id: string;
  business_id: string | null;
  supplier_id: string;
  purchase_receipt_id: string | null;
  cash_session_id: string | null;
  staff_id: string | null;
  amount: number;
  payment_method: 'cash' | 'card' | 'bank';
  note: string | null;
  created_at: string;
};

export type SupplierAccount = {
  supplier: Supplier;
  total_purchases: number;
  total_paid: number;
  balance: number;
  purchase_count: number;
  payment_count: number;
};

