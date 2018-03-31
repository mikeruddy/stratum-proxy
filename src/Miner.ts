import * as EventEmitter from "events";
import * as WebSocket from "ws";
import * as Net from "net";
import * as uuid from "uuid";
import Connection from "./Connection";
import Donation from "./Donation";
import Queue from "./Queue";
import { minersCounter, sharesCounter, sharesMeter } from "./Metrics";
import {
  Job,
  CoinHiveError,
  CoinHiveResponse,
  CoinHiveLoginParams,
  CoinHiveRequest,
  StratumRequest,
  StratumResponse,
  StratumRequestParams,
  StratumError,
  StratumJob
} from "./types";

export type Options = {
  connection: Connection | null;
  ws: WebSocket | null;
  stratumSocket: any | null;
  address: string | null;
  user: string | null;
  diff: number | null;
  pass: string | null;
  donations: Donation[] | null;
};

class Miner extends EventEmitter {
  id: string = uuid.v4();
  buffer: string = "";
  login: string = null;
  address: string = null;
  user: string = null;
  diff: number = null;
  pass: string = null;
  stratumSocket: any = null;
  donations: Donation[] = null;
  heartbeat: NodeJS.Timer = null;
  connection: Connection = null;
  queue: Queue = new Queue();
  ws: WebSocket = null;
  online: boolean = false;
  jobs: Job[] = [];
  hashes: number = 0;
  worker: string = null;

  constructor(options: Options) {
    super();
    this.connection = options.connection;
    this.ws = options.ws;
    this.stratumSocket = options.stratumSocket;
    this.address = options.address;
    this.user = options.user;
    this.diff = options.diff;
    this.pass = options.pass;
    this.donations = options.donations;
  }

  async connect() {
    console.log(`miner connected (${this.id}) via ${this.ws ? 'WebSocket' : 'Stratum'}`);
    
    if(this.ws) {
      this.donations.forEach(donation => donation.connect());
      this.ws.on("message", this.handleMessage.bind(this));
      this.ws.on("close", () => {
        if (this.online) {
          console.log(`miner connection closed (${this.id})`);
          this.kill();
        }
      });
      this.ws.on("error", error => {
        if (this.online) {
          console.log(`miner connection error (${this.id}):`, error.message);
          this.kill();
        }
      });
      
      minersCounter.inc();
      this.connection.on(this.id + ":authed", this.handleAuthed.bind(this));
      this.connection.on(this.id + ":job", this.handleJob.bind(this));
      this.connection.on(this.id + ":accepted", this.handleAccepted.bind(this));
      this.connection.on(this.id + ":error", this.handleError.bind(this));
    }
    
    if(this.stratumSocket) {
      this.buffer = '';
      
      
      this.stratumSocket.setKeepAlive(true);
      this.stratumSocket.setEncoding("utf8");
      
      this.stratumSocket.on("error", error => {
        this.kill();
      });
      this.stratumSocket.on("close", () => {
        this.kill();
      });
      this.stratumSocket.on("data", chunk => {
        this.buffer += chunk;
        while (this.buffer.includes("\n")) {
          const newLineIndex = this.buffer.indexOf("\n");
          const stratumMessage = this.buffer.slice(0, newLineIndex);
          this.buffer = this.buffer.slice(newLineIndex + 1);
          this.handleStratumMessage.bind(this)(stratumMessage);
        }
      });
    }
    
    
    this.queue.on("message", (message: StratumRequest) =>
      this.connection.send(this.id, message.method, message.params)
    );
    this.heartbeat = setInterval(() => this.connection.send(this.id, "keepalived"), 30000);
    this.online = true;
    await Promise.all(this.donations.map(donation => donation.ready));
    if (this.online) {
      this.queue.start();
      console.log(`miner started (${this.id})`);
      this.emit("open", {
        id: this.id
      });
    }
  }

  kill() {
    console.log('KILL ', this.id)
    this.queue.stop();
    this.connection.removeMiner(this.id);
    this.connection.removeAllListeners(this.id + ":authed");
    this.connection.removeAllListeners(this.id + ":job");
    this.connection.removeAllListeners(this.id + ":accepted");
    this.connection.removeAllListeners(this.id + ":error");
    this.donations.forEach(donation => donation.kill());
    this.jobs = [];
    this.donations = [];
    this.hashes = 0;
    if(this.ws) {
      this.ws.close();
    }
    if (this.stratumSocket) {
      try {
        this.stratumSocket.end();
        this.stratumSocket.destroy();
        console.warn('destroyed the socket')
      } catch (e) {
        console.warn(`something went wrong while destroying socket (${this.id}):`, e.message);
      }
    }
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    if (this.online) {
      this.online = false;
      minersCounter.dec();
      console.log(`miner disconnected (${this.id})`);
      this.emit("close", {
        id: this.id,
        login: this.login,
        worker: this.worker
      });
    }
    this.removeAllListeners();
  }

  sendToMiner(payload: CoinHiveResponse) {
    const coinhiveMessage = JSON.stringify(payload);
    if (this.online && this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(coinhiveMessage);
      } catch (e) {
        this.kill();
      }
    }
  }

  sendToStratumMiner(payload: any) {
    if(this.stratumSocket && this.stratumSocket.write) {
      console.log('TO MINER', payload)
      this.stratumSocket.write(JSON.stringify(payload) + "\n");
    } else {
      this.kill();
    }
  }
  
  handleStratumMessage(message: string) {
    let data: StratumRequest;
    try {
      data = JSON.parse(message);
    } catch (e) {
      console.warn(`can't parse message as JSON from miner:`, message, e.message);
      return;
    }
    
    switch (data.method) {
      case "login": {
        const params = data.params as CoinHiveLoginParams;
        this.login = this.address || params.site_key;
        const user = this.user || params.user;
        if (user) {
          this.login += "." + user;
        }
        if (this.diff) {
          this.login += "+" + this.diff;
        }
        
        this.id = params.login;
        
        
        minersCounter.inc();
        this.connection.on(this.id + ":authed", this.handleAuthed.bind(this));
        this.connection.on(this.id + ":job", this.handleJob.bind(this));
        this.connection.on(this.id + ":accepted", this.handleAccepted.bind(this));
        this.connection.on(this.id + ":error", this.handleError.bind(this));
        this.connection.on(this.id + ":result", this.handleResult.bind(this));
        
        this.connection.addMiner(this);
        
        this.sendToPool("login", {
          login: this.login,
          pass: this.pass
        });
        break;
      }

      case "submit": {
        const job = data.params as Job;
        console.log(`job submitted (${this.id}):`, job.job_id);
        if (!this.isDonation(job)) {
          this.sendToPool("submit", job);
        } else {
          const donation = this.getDonation(job);
          donation.submit(job);
          // this.sendToStratumMiner(data);
        }
        this.emit("found", {
          id: this.id,
          login: this.login,
          job
        });
        break;
      }
    }
  }

  sendToPool(method: string, params: StratumRequestParams) {
    this.queue.push({
      type: "message",
      payload: {
        method,
        params
      }
    });
  }

  handleAuthed(auth: string, response: StratumResponse): void {
    console.log(`miner authenticated (${this.id}):`, auth);
    if(this.ws) {
      this.sendToMiner({
        type: "authed",
        params: {
          token: "",
          hashes: 0
        }
      });
    }
    
    if(this.stratumSocket) {
      this.sendToStratumMiner(response);
    }
    
    this.emit("authed", {
      id: this.id,
      login: this.login,
      worker: this.worker,
      auth
    }, response);
  }

  handleJob(job: Job, request: StratumRequest): void {
    console.log(`job arrived (${this.id}):`, job.job_id);
    this.jobs.push(job);
    const donations = this.donations.filter(donation => donation.shouldDonateJob());
    donations.forEach(donation => {
      this.sendToMiner({
        type: "job",
        params: donation.getJob()
      });
    });
    if (!this.hasPendingDonations() && donations.length === 0) {
      if(this.ws) {
        this.sendToMiner({
          type: "job",
          params: this.jobs.pop()
        });
      }
      
      if(this.stratumSocket) {
        this.sendToStratumMiner(request);
      }
      
    }
    this.emit("job", {
      id: this.id,
      login: this.login,
      job,
      worker: this.worker
    });
  }

  handleResult(response: StratumResponse): void {
    if(this.stratumSocket) {
      console.log('sending result back to miner', response)
      this.sendToStratumMiner(response);
    }
  }

  handleAccepted(job: StratumJob): void {
    this.hashes++;
    console.log(`shares accepted (${this.id}):`, this.hashes);
    sharesCounter.inc();
    sharesMeter.mark();
    if(this.ws) {
      this.sendToMiner({
        type: "hash_accepted",
        params: {
          hashes: this.hashes
        }
      });
    }
    
    if(this.stratumSocket) {
      this.sendToStratumMiner(job);
    }
    
    this.emit("accepted", {
      id: this.id,
      login: this.login,
      hashes: this.hashes,
      worker: this.worker
    });
  }

  handleError(error: StratumError): void {
    console.warn(
      `pool connection error (${this.id}):`,
      error.error || (error && JSON.stringify(error)) || "unknown error"
    );
    if (this.online) {
      if (error.error === "invalid_site_key") {
        if(this.ws) {
          this.sendToMiner({
            type: "error",
            params: error
          });
        }
      }
      
      if(this.stratumSocket) {
        this.sendToStratumMiner(error);
      }
      
      this.emit("error", {
        id: this.id,
        login: this.login,
        error
      });
    }
    this.kill();
  }
  
  handleMessage(message: string) {
    let data: CoinHiveRequest;
    try {
      data = JSON.parse(message);
    } catch (e) {
      console.warn(`can't parse message as JSON from miner:`, message, e.message);
      return;
    }
    
    
    switch (data.type) {
      case "auth": {
        const params = data.params as CoinHiveLoginParams;
        this.login = this.address || params.site_key;
        const user = this.user || params.user;
        this.worker = user;
        
        console.log('USER IS', this.worker)
        
        if (user) {
          this.login += "." + user;
        }
        if (this.diff) {
          this.login += "+" + this.diff;
        }
        
        
        
        this.sendToPool("login", {
          login: this.login,
          pass: this.pass
        });
        break;
      }

      case "submit": {
        const job = data.params as Job;
        console.log(`job submitted (${this.id}):`, job.job_id);
        if (!this.isDonation(job)) {
          this.sendToPool("submit", job);
        } else {
          const donation = this.getDonation(job);
          donation.submit(job);
          this.sendToMiner({
            type: "hash_accepted",
            params: {
              hashes: ++this.hashes
            }
          });
        }
        this.emit("found", {
          id: this.id,
          login: this.login,
          job,
          worker: this.worker
        });
        break;
      }
    }
  }

  isDonation(job: Job): boolean {
    return this.donations.some(donation => donation.hasJob(job));
  }

  getDonation(job: Job): Donation {
    return this.donations.find(donation => donation.hasJob(job));
  }

  hasPendingDonations(): boolean {
    return this.donations.some(donation => donation.taken.filter(job => !job.done).length > 0);
  }
}

export default Miner;
