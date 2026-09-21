import { redisLooksLocal } from './app.config';

describe('redisLooksLocal', () => {
  it('treats the Docker default as local', () => {
    expect(redisLooksLocal('redis://127.0.0.1:6379/1')).toBe(true);
  });

  it('treats a Railway private host as remote', () => {
    expect(redisLooksLocal('redis://default:pass@redis.railway.internal:6379/1?family=0')).toBe(
      false,
    );
  });
});
