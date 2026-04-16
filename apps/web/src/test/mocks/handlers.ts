import { http, HttpResponse } from 'msw';

const API = 'http://localhost:3000/api/v1';

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
];
