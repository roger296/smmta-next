import { http, HttpResponse } from 'msw';

const API = 'http://localhost:8080/api/v1';

export const handlers = [
  // Default: empty customers list
  http.get(`${API}/customers`, () => {
    return HttpResponse.json({
      success: true,
      data: [],
      total: 0,
      page: 1,
      pageSize: 50,
      totalPages: 0,
    });
  }),

  // The stock-take start screen asks for the venue's open takes, so a second
  // counter can join one. Default: none open.
  http.get(`${API}/stock-takes`, () => HttpResponse.json({ success: true, data: [] })),
  // The count screen re-reads its take on a timer. A test that wants lines
  // back from that read installs its own handler; by default the take is
  // unknown, and the screen keeps whatever it was handed when it opened.
  http.get(`${API}/stock-takes/:id`, () =>
    HttpResponse.json({ success: false, error: 'Stock-take not found' }, { status: 404 }),
  ),
];
