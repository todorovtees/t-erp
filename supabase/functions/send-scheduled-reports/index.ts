// supabase/functions/send-scheduled-reports/index.ts
//
// DEPLOY REQUIRED — not live until you run:
//   supabase functions deploy send-scheduled-reports
//   supabase secrets set RESEND_API_KEY=your_key_here
// Then schedule it (Supabase Dashboard -> Edge Functions -> your function ->
// "Cron" tab, e.g. `0 8 * * *` for daily 08:00), or via pg_cron.
//
// Written against Resend (https://resend.com) as the email provider since
// it has the simplest API for this kind of transactional send; swap the
// fetch call in sendEmail() for any other provider's API if you prefer one
// you already use.
//
// Required secrets:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (Edge Function defaults/service role)
//   RESEND_API_KEY

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

async function sendEmail(to: string, subject: string, html: string) {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) throw new Error("RESEND_API_KEY not set");

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: "T-ERP <reports@todorovtees.com>", to: [to], subject, html }),
  });
  if (!res.ok) throw new Error(`Resend API error: ${res.status} ${await res.text()}`);
}

function renderReportHtml(reportType: string, data: any): string {
  if (reportType === "sales_summary") {
    return `<h2>Дневен отчет продажби</h2>
      <p>Оборот: ${data?.total_revenue ?? 0} EUR</p>
      <p>Брой продажби: ${data?.order_count ?? 0}</p>`;
  }
  if (reportType === "low_stock") {
    const rows = (data ?? []).map((r: any) => `<tr><td>${r.product_name}</td><td>${r.sku}</td><td>${r.on_hand}</td></tr>`).join("");
    return `<h2>Продукти под минимална наличност</h2><table border="1" cellpadding="6"><tr><th>Продукт</th><th>SKU</th><th>Наличност</th></tr>${rows}</table>`;
  }
  return `<pre>${JSON.stringify(data, null, 2)}</pre>`;
}

Deno.serve(async (_req: Request) => {
  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // service_role bypasses RLS, so due_scheduled_reports() runs unrestricted
  // here — this function is the one place that's expected/safe.
  const { data: dueReports, error } = await admin.rpc("due_scheduled_reports");
  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  const results: any[] = [];

  for (const report of dueReports ?? []) {
    try {
      let reportData: any = null;

      if (report.report_type === "sales_summary") {
        const today = new Date().toISOString().slice(0, 10);
        const { data } = await admin.rpc("get_sales_report", {
          p_company_id: report.company_id, p_date_from: today, p_date_to: today, p_warehouse_id: null,
        });
        reportData = data;
      } else if (report.report_type === "low_stock") {
        const { data } = await admin
          .from("v_inventory_detail")
          .select("product_name, sku, on_hand")
          .eq("company_id", report.company_id)
          .in("stock_status", ["low", "critical", "out"]);
        reportData = data;
      }

      await sendEmail(
        report.recipient_email,
        `T-ERP — ${report.report_type} (${report.cadence})`,
        renderReportHtml(report.report_type, reportData)
      );

      await admin.from("scheduled_reports").update({ last_sent_at: new Date().toISOString() }).eq("id", report.id);
      results.push({ id: report.id, status: "sent" });
    } catch (err) {
      results.push({ id: report.id, status: "error", message: String(err) });
    }
  }

  return new Response(JSON.stringify({ processed: results.length, results }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
});
