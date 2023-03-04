import axios, { AxiosError } from 'axios';

class HttpClient {
  public async get<T>(link: string): Promise<T> {
    try {
      const { data } = await axios.get<T>(link);

      return data;
    } catch (error) {
      switch (true) {
        case error.code === 'ECONNREFUSED': {
          console.log('http_client_econnrefused', error.message);
          break;
        }
        case (error as AxiosError).response?.status === 502: {
          console.log('http_client_status_502', error.message);
          break;
        }
        default: {
          console.log('http_client_error', JSON.stringify(error));
          break;
        }
      }

      return;
    }
  }
}

export const httpClient = new HttpClient();
