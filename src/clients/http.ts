import axios, { AxiosError } from 'axios';
import { log } from '../logs';

class HttpClient {
  public async get<T>(link: string, token: string): Promise<T> {
    try {
      const { data } = await axios.get<T>(link, {
        headers: {
          token,
        },
      });

      return data;
    } catch (error) {
      switch (true) {
        case error.code === 'ECONNREFUSED': {
          log('http_client_econnrefused', error.message);
          break;
        }
        case (error as AxiosError).response?.status === 502: {
          log('http_client_status_502', error.message);
          break;
        }
        default: {
          log('http_client_error', error.message);
          break;
        }
      }

      return;
    }
  }
}

export const httpClient = new HttpClient();
