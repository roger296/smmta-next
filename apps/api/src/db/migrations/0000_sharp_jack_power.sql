CREATE TYPE "public"."allocation_item_type" AS ENUM('INVOICE', 'CREDIT_NOTE', 'PAYMENT', 'SUPPLIER_INVOICE', 'SUPPLIER_CREDIT_NOTE', 'SUPPLIER_PAYMENT');--> statement-breakpoint
CREATE TYPE "public"."credit_note_status" AS ENUM('DRAFT', 'ISSUED', 'ALLOCATED', 'VOIDED');--> statement-breakpoint
CREATE TYPE "public"."gl_posting_status" AS ENUM('PENDING', 'SUCCESS', 'FAILED', 'RETRYING');--> statement-breakpoint
CREATE TYPE "public"."grn_status" AS ENUM('PENDING', 'COMPLETED');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'VOIDED');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('DRAFT', 'CONFIRMED', 'ALLOCATED', 'PARTIALLY_ALLOCATED', 'BACK_ORDERED', 'READY_TO_SHIP', 'PARTIALLY_SHIPPED', 'SHIPPED', 'INVOICED', 'COMPLETED', 'CANCELLED', 'ON_HOLD');--> statement-breakpoint
CREATE TYPE "public"."po_delivery_status" AS ENUM('PENDING', 'PARTIALLY_RECEIVED', 'FULLY_RECEIVED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."po_invoice_status" AS ENUM('NOT_INVOICED', 'PARTIALLY_INVOICED', 'FULLY_INVOICED');--> statement-breakpoint
CREATE TYPE "public"."product_type" AS ENUM('PHYSICAL', 'SERVICE');--> statement-breakpoint
CREATE TYPE "public"."source_channel" AS ENUM('MANUAL', 'SHOPIFY', 'AMAZON', 'EBAY', 'ETSY', 'WOOCOMMERCE', 'CSV', 'API');--> statement-breakpoint
CREATE TYPE "public"."stock_item_status" AS ENUM('IN_STOCK', 'ALLOCATED', 'SOLD', 'RETURNED', 'WRITTEN_OFF', 'IN_TRANSIT');--> statement-breakpoint
CREATE TYPE "public"."supplier_address_type" AS ENUM('INVOICE', 'WAREHOUSE');--> statement-breakpoint
CREATE TYPE "public"."supplier_invoice_status" AS ENUM('DRAFT', 'APPROVED', 'PARTIALLY_PAID', 'PAID', 'VOIDED');--> statement-breakpoint
CREATE TYPE "public"."vat_treatment" AS ENUM('STANDARD_VAT_20', 'REDUCED_VAT_5', 'ZERO_RATED', 'EXEMPT', 'OUTSIDE_SCOPE', 'REVERSE_CHARGE', 'POSTPONED_VAT');--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"old_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "currencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(3) NOT NULL,
	"name" varchar(50) NOT NULL,
	"symbol" varchar(5),
	"exchange_rate_to_base" numeric(18, 8) DEFAULT '1',
	"old_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "currencies_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "manufacturers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(200) NOT NULL,
	"description" text,
	"logo_url" varchar(500),
	"website" varchar(500),
	"customer_support_phone" varchar(50),
	"customer_support_email" varchar(100),
	"tech_support_phone" varchar(50),
	"tech_support_email" varchar(100),
	"old_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "warehouses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"address_line1" varchar(255),
	"address_line2" varchar(255),
	"city" varchar(100),
	"region" varchar(100),
	"post_code" varchar(50),
	"country" varchar(50),
	"is_default" boolean DEFAULT false NOT NULL,
	"old_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "customer_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"name" varchar(200),
	"job_title" varchar(100),
	"office_phone" varchar(100),
	"extension" varchar(20),
	"mobile" varchar(50),
	"email" varchar(100),
	"skype" varchar(100),
	"twitter" varchar(100),
	"old_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "customer_delivery_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"contact_name" varchar(100),
	"line1" varchar(255),
	"line2" varchar(255),
	"city" varchar(100),
	"region" varchar(100),
	"post_code" varchar(50),
	"country" varchar(50),
	"is_default" boolean DEFAULT false NOT NULL,
	"old_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "customer_invoice_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid,
	"contact_name" varchar(100),
	"line1" varchar(255),
	"line2" varchar(255),
	"city" varchar(100),
	"region" varchar(100),
	"post_code" varchar(50),
	"country" varchar(50),
	"invoice_text" text,
	"old_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "customer_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"note" text NOT NULL,
	"user_id" uuid,
	"attachment_url" varchar(500),
	"is_marked" boolean DEFAULT false NOT NULL,
	"old_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "customer_product_prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"price" numeric(18, 2) NOT NULL,
	"old_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "customer_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" varchar(150) NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"old_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"short_name" varchar(50),
	"type_id" uuid,
	"email" varchar(100),
	"credit_limit" numeric(18, 2) DEFAULT '0',
	"credit_currency_code" varchar(3) DEFAULT 'GBP',
	"credit_term_days" integer DEFAULT 30,
	"tax_rate_percent" numeric(5, 2) DEFAULT '20',
	"vat_treatment" "vat_treatment" DEFAULT 'STANDARD_VAT_20' NOT NULL,
	"vat_registration_number" varchar(50),
	"company_registration_number" varchar(50),
	"country_code" varchar(3),
	"default_revenue_account_code" varchar(10),
	"warehouse_id" uuid,
	"old_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "pallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"product_id" uuid,
	"product_sku" varchar(100),
	"pallet_serial_no" varchar(100),
	"item_count" integer DEFAULT 0,
	"is_available" boolean DEFAULT true NOT NULL,
	"order_id" uuid,
	"old_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "product_category_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "product_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"description" text,
	"group_type" varchar(50),
	"old_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "product_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"image_url" varchar(500) NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"old_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" varchar(500) NOT NULL,
	"stock_code" varchar(100),
	"manufacturer_id" uuid,
	"manufacturer_part_number" varchar(100),
	"description" text,
	"expected_next_cost" numeric(18, 2) DEFAULT '0',
	"min_selling_price" numeric(18, 2),
	"max_selling_price" numeric(18, 2),
	"ean" varchar(50),
	"product_type" "product_type" DEFAULT 'PHYSICAL' NOT NULL,
	"require_serial_number" boolean DEFAULT false NOT NULL,
	"require_batch_number" boolean DEFAULT false NOT NULL,
	"weight" numeric(10, 3),
	"length" numeric(10, 2),
	"width" numeric(10, 2),
	"height" numeric(10, 2),
	"country_of_origin" varchar(3),
	"hs_code" varchar(20),
	"supplier_id" uuid,
	"default_warehouse_id" uuid,
	"marketplace_identifiers" jsonb,
	"old_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "stock_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"serial_number" varchar(100),
	"batch_id" varchar(100),
	"warehouse_id" uuid NOT NULL,
	"location_isle" varchar(50),
	"location_shelf" varchar(50),
	"location_bin" varchar(50),
	"quantity" double precision DEFAULT 1 NOT NULL,
	"status" "stock_item_status" DEFAULT 'IN_STOCK' NOT NULL,
	"booked_in_date" varchar(10),
	"booked_out_date" varchar(10),
	"purchase_order_id" uuid,
	"sales_order_id" uuid,
	"value" numeric(18, 2) DEFAULT '0',
	"currency_code" varchar(3) DEFAULT 'GBP',
	"old_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"first_item_id" uuid NOT NULL,
	"first_item_type" "allocation_item_type" NOT NULL,
	"second_item_id" uuid NOT NULL,
	"second_item_type" "allocation_item_type" NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"allocation_date" date NOT NULL,
	"voided" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"old_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "credit_note_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"credit_note_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"description" text,
	"quantity" double precision NOT NULL,
	"price_per_unit" numeric(18, 2) NOT NULL,
	"tax_rate" double precision DEFAULT 0,
	"tax_value" numeric(18, 2) DEFAULT '0',
	"line_total" numeric(18, 2) NOT NULL,
	"old_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "credit_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"invoice_id" uuid,
	"customer_id" uuid NOT NULL,
	"contact_id" uuid,
	"address_id" uuid,
	"currency_code" varchar(3) DEFAULT 'GBP' NOT NULL,
	"credit_note_number" varchar(50),
	"delivery_charge" numeric(18, 2) DEFAULT '0',
	"line_total" numeric(18, 2) DEFAULT '0',
	"tax_total" numeric(18, 2) DEFAULT '0',
	"credit_note_total" numeric(18, 2) NOT NULL,
	"amount_outstanding" numeric(18, 2) NOT NULL,
	"status" "credit_note_status" DEFAULT 'DRAFT' NOT NULL,
	"vat_treatment" "vat_treatment" DEFAULT 'STANDARD_VAT_20' NOT NULL,
	"date_of_credit_note" date NOT NULL,
	"pdf_url" varchar(500),
	"old_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "custom_order_statuses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"old_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "customer_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"order_number" varchar(100) NOT NULL,
	"customer_id" uuid NOT NULL,
	"contact_id" uuid,
	"invoice_address_id" uuid,
	"delivery_address_id" uuid,
	"warehouse_id" uuid,
	"currency_code" varchar(3) DEFAULT 'GBP' NOT NULL,
	"delivery_charge" numeric(18, 2) DEFAULT '0',
	"order_total" numeric(18, 2) DEFAULT '0',
	"tax_total" numeric(18, 2) DEFAULT '0',
	"grand_total" numeric(18, 2) DEFAULT '0',
	"status" "order_status" DEFAULT 'DRAFT' NOT NULL,
	"custom_status_id" uuid,
	"payment_method" varchar(100),
	"order_date" date NOT NULL,
	"delivery_date" date,
	"shipped_date" date,
	"tax_inclusive" boolean DEFAULT false NOT NULL,
	"vat_treatment" "vat_treatment" DEFAULT 'STANDARD_VAT_20' NOT NULL,
	"source_channel" "source_channel" DEFAULT 'MANUAL' NOT NULL,
	"integration_metadata" jsonb,
	"tracking_number" varchar(200),
	"tracking_link" varchar(500),
	"courier_name" varchar(100),
	"revenue" numeric(18, 2) DEFAULT '0',
	"cogs" numeric(18, 2) DEFAULT '0',
	"margin" numeric(18, 2) DEFAULT '0',
	"third_party_order_id" varchar(100),
	"customer_order_number" varchar(100),
	"factory_order_number" varchar(100),
	"is_problem_order" boolean DEFAULT false NOT NULL,
	"problem_type" varchar(50),
	"old_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "invoice_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"quantity" double precision NOT NULL,
	"price_per_unit" numeric(18, 2) NOT NULL,
	"tax_name" varchar(100),
	"tax_rate" double precision DEFAULT 0,
	"tax_value" numeric(18, 2) DEFAULT '0',
	"line_total" numeric(18, 2) NOT NULL,
	"return_qty" double precision DEFAULT 0,
	"old_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"order_id" uuid,
	"customer_id" uuid NOT NULL,
	"contact_id" uuid,
	"invoice_address_id" uuid,
	"delivery_address_id" uuid,
	"currency_code" varchar(3) DEFAULT 'GBP' NOT NULL,
	"invoice_number" varchar(50),
	"delivery_charge" numeric(18, 2) DEFAULT '0',
	"line_total" numeric(18, 2) DEFAULT '0',
	"tax_total" numeric(18, 2) DEFAULT '0',
	"grand_total" numeric(18, 2) NOT NULL,
	"amount_outstanding" numeric(18, 2) NOT NULL,
	"status" "invoice_status" DEFAULT 'DRAFT' NOT NULL,
	"vat_treatment" "vat_treatment" DEFAULT 'STANDARD_VAT_20' NOT NULL,
	"date_of_invoice" date NOT NULL,
	"due_date_of_invoice" date,
	"pdf_url" varchar(500),
	"old_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"quantity" double precision NOT NULL,
	"price_per_unit" numeric(18, 2) NOT NULL,
	"tax_name" varchar(150),
	"tax_rate" double precision DEFAULT 0,
	"tax_value" numeric(18, 2) DEFAULT '0',
	"line_total" numeric(18, 2) NOT NULL,
	"number_shipped" double precision DEFAULT 0,
	"remaining_quantity" integer DEFAULT 0,
	"third_party_product_id" varchar(100),
	"old_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "order_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"note" text NOT NULL,
	"user_id" uuid,
	"attachment_url" varchar(500),
	"is_marked" boolean DEFAULT false NOT NULL,
	"is_picking_note" boolean DEFAULT false NOT NULL,
	"old_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "goods_received_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"grn_number" varchar(100),
	"date_booked_in" date NOT NULL,
	"supplier_delivery_note_no" varchar(100),
	"status" "grn_status" DEFAULT 'COMPLETED' NOT NULL,
	"supporting_doc_url" varchar(500),
	"old_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "grn_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"grn_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"quantity" double precision NOT NULL,
	"qty_booked_in" double precision NOT NULL,
	"old_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "purchase_order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"quantity" double precision NOT NULL,
	"price_per_unit" numeric(18, 2) NOT NULL,
	"tax_name" varchar(150),
	"tax_rate" double precision DEFAULT 0,
	"tax_value" numeric(18, 2) DEFAULT '0',
	"line_total" numeric(18, 2) NOT NULL,
	"qty_booked_in" double precision DEFAULT 0,
	"qty_invoiced" double precision DEFAULT 0,
	"delivery_status" "po_delivery_status" DEFAULT 'PENDING' NOT NULL,
	"account_code" varchar(10),
	"expected_delivery_date" date,
	"old_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"contact_id" uuid,
	"address_id" uuid,
	"delivery_warehouse_id" uuid,
	"currency_code" varchar(3) DEFAULT 'GBP' NOT NULL,
	"po_number" varchar(100) NOT NULL,
	"delivery_charge" numeric(18, 2) DEFAULT '0',
	"line_total" numeric(18, 2) DEFAULT '0',
	"tax_total" numeric(18, 2) DEFAULT '0',
	"grand_total" numeric(18, 2) DEFAULT '0',
	"delivery_status" "po_delivery_status" DEFAULT 'PENDING' NOT NULL,
	"invoiced_status" "po_invoice_status" DEFAULT 'NOT_INVOICED' NOT NULL,
	"exchange_rate" numeric(18, 8) DEFAULT '1',
	"vat_treatment" "vat_treatment" DEFAULT 'STANDARD_VAT_20' NOT NULL,
	"expected_delivery_date" date,
	"tracking_number" varchar(200),
	"old_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "supplier_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"supplier_id" uuid NOT NULL,
	"contact_name" varchar(100),
	"line1" varchar(255),
	"line2" varchar(255),
	"city" varchar(100),
	"region" varchar(100),
	"post_code" varchar(50),
	"country" varchar(50),
	"address_type" "supplier_address_type" DEFAULT 'INVOICE' NOT NULL,
	"old_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "supplier_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"supplier_id" uuid NOT NULL,
	"name" varchar(200),
	"job_title" varchar(100),
	"phone" varchar(100),
	"extension" varchar(20),
	"mobile" varchar(50),
	"email" varchar(100),
	"skype" varchar(100),
	"old_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "supplier_credit_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"supplier_invoice_id" uuid,
	"supplier_id" uuid NOT NULL,
	"contact_id" uuid,
	"address_id" uuid,
	"currency_code" varchar(3) DEFAULT 'GBP' NOT NULL,
	"credit_note_number" varchar(100),
	"delivery_charge" numeric(18, 2) DEFAULT '0',
	"line_total" numeric(18, 2) DEFAULT '0',
	"tax_total" numeric(18, 2) DEFAULT '0',
	"credit_note_total" numeric(18, 2) NOT NULL,
	"amount_outstanding" numeric(18, 2) NOT NULL,
	"status" "credit_note_status" DEFAULT 'DRAFT' NOT NULL,
	"vat_treatment" "vat_treatment" DEFAULT 'STANDARD_VAT_20' NOT NULL,
	"date_of_credit_note" date NOT NULL,
	"old_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "supplier_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"purchase_order_id" uuid,
	"supplier_id" uuid NOT NULL,
	"contact_id" uuid,
	"address_id" uuid,
	"currency_code" varchar(3) DEFAULT 'GBP' NOT NULL,
	"invoice_number" varchar(100),
	"delivery_charge" numeric(18, 2) DEFAULT '0',
	"line_total" numeric(18, 2) DEFAULT '0',
	"tax_total" numeric(18, 2) DEFAULT '0',
	"grand_total" numeric(18, 2) NOT NULL,
	"amount_outstanding" numeric(18, 2) NOT NULL,
	"status" "supplier_invoice_status" DEFAULT 'DRAFT' NOT NULL,
	"vat_treatment" "vat_treatment" DEFAULT 'STANDARD_VAT_20' NOT NULL,
	"date_of_invoice" date NOT NULL,
	"due_date_of_invoice" date,
	"pdf_url" varchar(500),
	"old_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "supplier_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"supplier_id" uuid NOT NULL,
	"note" text NOT NULL,
	"user_id" uuid,
	"attachment_url" varchar(500),
	"is_marked" boolean DEFAULT false NOT NULL,
	"old_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"type" varchar(100),
	"email" varchar(200),
	"accounts_email" varchar(200),
	"website" varchar(500),
	"currency_code" varchar(3) DEFAULT 'GBP',
	"credit_limit" numeric(18, 2) DEFAULT '0',
	"credit_term_days" integer DEFAULT 30,
	"tax_rate_percent" numeric(5, 2) DEFAULT '20',
	"vat_treatment" "vat_treatment" DEFAULT 'STANDARD_VAT_20' NOT NULL,
	"vat_registration_number" varchar(50),
	"country_code" varchar(3),
	"lead_time_days" integer,
	"default_expense_account_code" varchar(10),
	"old_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "gl_posting_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"entity_type" varchar(50) NOT NULL,
	"entity_id" varchar(100) NOT NULL,
	"luca_transaction_type" varchar(50) NOT NULL,
	"luca_transaction_id" varchar(100),
	"idempotency_key" varchar(200) NOT NULL,
	"amount" numeric(18, 2),
	"description" text,
	"status" "gl_posting_status" DEFAULT 'PENDING' NOT NULL,
	"error_message" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"request_payload" jsonb,
	"response_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "gl_posting_log_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "customer_contacts" ADD CONSTRAINT "customer_contacts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_delivery_addresses" ADD CONSTRAINT "customer_delivery_addresses_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_invoice_addresses" ADD CONSTRAINT "customer_invoice_addresses_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_notes" ADD CONSTRAINT "customer_notes_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_type_id_customer_types_id_fk" FOREIGN KEY ("type_id") REFERENCES "public"."customer_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pallets" ADD CONSTRAINT "pallets_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_category_mappings" ADD CONSTRAINT "product_category_mappings_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_category_mappings" ADD CONSTRAINT "product_category_mappings_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_manufacturer_id_manufacturers_id_fk" FOREIGN KEY ("manufacturer_id") REFERENCES "public"."manufacturers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_default_warehouse_id_warehouses_id_fk" FOREIGN KEY ("default_warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_note_lines" ADD CONSTRAINT "credit_note_lines_credit_note_id_credit_notes_id_fk" FOREIGN KEY ("credit_note_id") REFERENCES "public"."credit_notes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_note_lines" ADD CONSTRAINT "credit_note_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_contact_id_customer_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."customer_contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_address_id_customer_invoice_addresses_id_fk" FOREIGN KEY ("address_id") REFERENCES "public"."customer_invoice_addresses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_orders" ADD CONSTRAINT "customer_orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_orders" ADD CONSTRAINT "customer_orders_contact_id_customer_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."customer_contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_orders" ADD CONSTRAINT "customer_orders_invoice_address_id_customer_invoice_addresses_id_fk" FOREIGN KEY ("invoice_address_id") REFERENCES "public"."customer_invoice_addresses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_orders" ADD CONSTRAINT "customer_orders_delivery_address_id_customer_delivery_addresses_id_fk" FOREIGN KEY ("delivery_address_id") REFERENCES "public"."customer_delivery_addresses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_orders" ADD CONSTRAINT "customer_orders_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_orders" ADD CONSTRAINT "customer_orders_custom_status_id_custom_order_statuses_id_fk" FOREIGN KEY ("custom_status_id") REFERENCES "public"."custom_order_statuses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_order_id_customer_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."customer_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_contact_id_customer_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."customer_contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_invoice_address_id_customer_invoice_addresses_id_fk" FOREIGN KEY ("invoice_address_id") REFERENCES "public"."customer_invoice_addresses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_delivery_address_id_customer_delivery_addresses_id_fk" FOREIGN KEY ("delivery_address_id") REFERENCES "public"."customer_delivery_addresses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_order_id_customer_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."customer_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_notes" ADD CONSTRAINT "order_notes_order_id_customer_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."customer_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_received_notes" ADD CONSTRAINT "goods_received_notes_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grn_lines" ADD CONSTRAINT "grn_lines_grn_id_goods_received_notes_id_fk" FOREIGN KEY ("grn_id") REFERENCES "public"."goods_received_notes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grn_lines" ADD CONSTRAINT "grn_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_contact_id_supplier_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."supplier_contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_address_id_supplier_addresses_id_fk" FOREIGN KEY ("address_id") REFERENCES "public"."supplier_addresses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_delivery_warehouse_id_warehouses_id_fk" FOREIGN KEY ("delivery_warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_addresses" ADD CONSTRAINT "supplier_addresses_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_contacts" ADD CONSTRAINT "supplier_contacts_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_credit_notes" ADD CONSTRAINT "supplier_credit_notes_supplier_invoice_id_supplier_invoices_id_fk" FOREIGN KEY ("supplier_invoice_id") REFERENCES "public"."supplier_invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_credit_notes" ADD CONSTRAINT "supplier_credit_notes_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_credit_notes" ADD CONSTRAINT "supplier_credit_notes_contact_id_supplier_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."supplier_contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_credit_notes" ADD CONSTRAINT "supplier_credit_notes_address_id_supplier_addresses_id_fk" FOREIGN KEY ("address_id") REFERENCES "public"."supplier_addresses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_contact_id_supplier_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."supplier_contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_address_id_supplier_addresses_id_fk" FOREIGN KEY ("address_id") REFERENCES "public"."supplier_addresses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_notes" ADD CONSTRAINT "supplier_notes_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;