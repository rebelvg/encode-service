import axios from 'axios';

class HttpClient {
  public async get<T>(link: string): Promise<T> {
    try {
      const { data } = await axios.get<T>(link);

      return data;
    } catch (error) {
      switch (true) {
        case error.code === 'ECONNREFUSED': {
          console.log('nms_update_econnrefused', error.message);
          break;
        }
        case error?.response?.status === 502: {
          console.log('nms_update_status_502', error.message);
          break;
        }
        default: {
          console.log(error);
        }
      }

      return;
    }
  }
}

export const httpClient = new HttpClient();
