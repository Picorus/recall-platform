// How a final report is shown (P3.14.1): the brand portal link, the page and the PDF, from the
// workers' renderers. Shared by the API's sending loop and the admin's report routes.
import type { ReportRender } from '@recall/db';
import { renderReportHtml, renderReportPdf } from '@recall/workers';

export function reportRender(portalUrl: string): ReportRender {
  return {
    link: (bookingId) => `${portalUrl}/campaigns/${encodeURIComponent(bookingId)}/report`,
    html: renderReportHtml,
    pdf: renderReportPdf,
  };
}
