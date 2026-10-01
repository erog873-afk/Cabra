// Backend Gift Apex: Telegram payments + dynamic cases/gifts admin API.
// Node 18+, no dependencies. Existing balance/top-up logic is preserved.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, 'public');
const MIME = {
  '.html':'text/html; charset=utf-8',
  '.js':'text/javascript; charset=utf-8',
  '.css':'text/css',
  '.png':'image/png',
  '.jpg':'image/jpeg',
  '.jpeg':'image/jpeg',
  '.svg':'image/svg+xml',
  '.webp':'image/webp',
  '.json':'application/json'
};

const BOT_TOKEN = process.env.BOT_TOKEN || 'ВСТАВЬ_СЮДА_ТОКЕН_БОТА';
const SECRET = process.env.WEBHOOK_SECRET || 'ВСТАВЬ_СЮДА_ЛЮБУЮ_ДЛИННУЮ_СТРОКУ';
const ADMIN_IDS = String(process.env.ADMIN_IDS || '').split(',').map(s=>s.trim()).filter(Boolean);
const DB_FILE = path.join(__dirname, 'db.json');

const DEFAULT_CASES = [
  {id:'poor',section:'Рулетка со звездами',name:'Нищий',icon:'',price:50,gradient:'gray',enabled:true,gifts:[
    {id:'g15',name:'',icon:'',price:15,chance:24.98},
    {id:'g25',name:'',icon:'',price:25,chance:24.98},
    {id:'g40',name:'',icon:'',price:40,chance:24.98},
    {id:'g60',name:'',icon:'',price:60,chance:24.98},
    {id:'g80',name:'',icon:'',price:80,chance:0.01},
    {id:'g100',name:'',icon:'',price:100,chance:0.01},
    {id:'g150',name:'',icon:'',price:150,chance:0.01},
    {id:'g200',name:'',icon:'',price:200,chance:0.01},
    {id:'g250',name:'',icon:'',price:250,chance:0.01},
    {id:'g300',name:'',icon:'',price:300,chance:0.01},
    {id:'g400',name:'',icon:'',price:400,chance:0.01},
    {id:'g500',name:'',icon:'',price:500,chance:0.01}
  ]},
  {id:'worker',section:'Рулетка со звездами',name:'Работяга',icon:'',price:100,gradient:'gray',enabled:true,gifts:[]},
  {id:'farmer',section:'Рулетка со звездами',name:'Фармила',icon:'',price:200,gradient:'gray',enabled:true,gifts:[]},
  {id:'rich',section:'Рулетка со звездами',name:'Богатый',icon:'',price:500,gradient:'purple',enabled:true,gifts:[]},
  {id:'icecream',section:'Рулетка с NFT',name:'Мороженое',icon:'https://storage.portal-market.com/portals-market/gifts/vicecream/models/png/pumpkinspice.png',price:200,gradient:'purple',enabled:true,gifts:[]},
  {id:'snake',section:'Рулетка с NFT',name:'Змея',icon:'https://storage.portal-market.com/portals-market/gifts/lovepotion/models/png/aerogel.png',price:250,gradient:'purple',enabled:true,gifts:[]},
  {id:'torch',section:'Рулетка с NFT',name:'Факел',icon:'https://storage.portal-market.com/portals-market/gifts/chillflame/models/png/losangeles.png',price:300,gradient:'purple',enabled:true,gifts:[]},
  {id:'cigar',section:'Рулетка с NFT',name:'Сигара',icon:'https://storage.portal-market.com/portals-market/gifts/vintagecigar/models/png/aquaviolet.png',price:350,gradient:'purple',enabled:true,gifts:[]},
  {id:'aladdin',section:'Рулетка с NFT',name:'Аладдин',icon:'',price:400,gradient:'purple',enabled:true,gifts:[]},
  {id:'ring',section:'Рулетка с NFT',name:'Кольцо',icon:'',price:450,gradient:'purple',enabled:true,gifts:[]},
  {id:'investor',section:'Рулетка с NFT',name:'Инвестор',icon:'',price:500,gradient:'purple',enabled:true,gifts:[]},
  {id:'cap',section:'Рулетка с NFT',name:'Кепка',icon:'',price:600,gradient:'purple',enabled:true,gifts:[]}
];

function loadDb(){
  if(!fs.existsSync(DB_FILE)){
    const d={balances:{},charges:{},cases:DEFAULT_CASES,version:1};
    fs.writeFileSync(DB_FILE,JSON.stringify(d,null,2));
    return d;
  }
  try{
    const d=JSON.parse(fs.readFileSync(DB_FILE,'utf8'));
    d.balances ||= {};
    d.charges ||= {};
    d.cases ||= DEFAULT_CASES;
    d.version ||= 1;
    return d;
  }catch(e){
    console.error('db.json is invalid:',e);
    return {balances:{},charges:{},cases:DEFAULT_CASES,version:1};
  }
}
const db=loadDb();
const save=()=>fs.writeFileSync(DB_FILE,JSON.stringify(db,null,2));

const tgApi=(m,body)=>fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${m}`,{
  method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)
}).then(r=>r.json());

function userFromInitData(initData){
  if(!initData)return null;
  try{
    const p=new URLSearchParams(initData),hash=p.get('hash');
    if(!hash)return null;
    p.delete('hash');
    const check=[...p.entries()].map(([k,v])=>`${k}=${v}`).sort().join('\n');
    const key=crypto.createHmac('sha256','WebAppData').update(BOT_TOKEN).digest();
    const calc=crypto.createHmac('sha256',key).update(check).digest('hex');
    if(!crypto.timingSafeEqual(Buffer.from(calc),Buffer.from(hash)))return null;
    const auth=Number(p.get('auth_date'));
    if(!auth || Date.now()/1000-auth>86400)return null;
    return JSON.parse(p.get('user'));
  }catch(e){return null}
}

const readBody=req=>new Promise((resolve,reject)=>{
  let s='';
  req.on('data',c=>{s+=c;if(s.length>2e6)reject(new Error('body too large'))});
  req.on('end',()=>{try{resolve(s?JSON.parse(s):{})}catch(e){reject(e)}});
  req.on('error',reject);
});

function send(res,code,obj){
  res.writeHead(code,{
    'Content-Type':'application/json; charset=utf-8',
    'Access-Control-Allow-Origin':'*',
    'Access-Control-Allow-Headers':'Content-Type, X-Init-Data, X-Telegram-Init-Data, X-Admin-Secret',
    'Access-Control-Allow-Methods':'GET,POST,PUT,OPTIONS'
  });
  res.end(JSON.stringify(obj));
}
function publicCase(c){
  return {
    id:String(c.id),section:String(c.section||'Рулетка с NFT'),name:String(c.name||''),
    icon:String(c.icon||''),price:Number(c.price)||0,gradient:String(c.gradient||'purple'),
    enabled:c.enabled!==false,
    gifts:Array.isArray(c.gifts)?c.gifts.map(g=>({
      id:String(g.id||''),name:String(g.name||''),icon:String(g.icon||''),
      price:Number(g.price)||0,chance:Number(g.chance)||0
    })):[]
  };
}
function adminOk(req,user){
  if(user && ADMIN_IDS.includes(String(user.id)))return true;
  const secret=process.env.ADMIN_SECRET;
  return !!secret && req.headers['x-admin-secret']===secret;
}
function normalizeCases(list){
  if(!Array.isArray(list))throw new Error('cases must be an array');
  return list.map((c,i)=>{
    const gifts=Array.isArray(c.gifts)?c.gifts.map((g,j)=>({
      id:String(g.id||`gift_${Date.now()}_${i}_${j}`),
      name:String(g.name||'').slice(0,200),
      icon:String(g.icon||'').slice(0,2000),
      price:Number(g.price)||0,
      chance:Number(g.chance)||0
    })):[];
    return {
      id:String(c.id||`case_${Date.now()}_${i}`),
      section:String(c.section||'Рулетка с NFT').slice(0,100),
      name:String(c.name||'').slice(0,100),
      icon:String(c.icon||'').slice(0,2000),
      price:Number(c.price)||0,
      gradient:['gray','purple','pink','red'].includes(c.gradient)?c.gradient:'purple',
      enabled:c.enabled!==false,
      gifts
    };
  });
}

http.createServer(async(req,res)=>{
  try{
    if(req.method==='OPTIONS')return send(res,204,{});
    const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);

    // Telegram webhook/payment logic — kept from the original server.
    if(req.method==='POST' && url.pathname===`/webhook/${SECRET}`){
      const u=await readBody(req);
      if(u.pre_checkout_query){
        await tgApi('answerPreCheckoutQuery',{pre_checkout_query_id:u.pre_checkout_query.id,ok:true});
      }
      const sp=u.message&&u.message.successful_payment;
      if(sp){
        const id=sp.telegram_payment_charge_id;
        if(!db.charges[id]){
          const uid=String(u.message.from.id);
          db.charges[id]={uid,amount:sp.total_amount};
          db.balances[uid]=(db.balances[uid]||0)+sp.total_amount;
          save();
        }
      }
      return send(res,200,{ok:true});
    }

    // Public static files.
    if(req.method==='GET' && !url.pathname.startsWith('/api/')){
      let p=decodeURIComponent(url.pathname);
      if(p==='/')p='/index.html';
      const f=path.join(PUBLIC,path.normalize(p));
      if(f.startsWith(PUBLIC+path.sep)&&fs.existsSync(f)&&fs.statSync(f).isFile()){
        res.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'});
        return fs.createReadStream(f).pipe(res);
      }
      return send(res,404,{error:'not found'});
    }

    // Public case data.
    if(req.method==='GET' && url.pathname==='/api/cases'){
      return send(res,200,{version:db.version||1,cases:db.cases.map(publicCase)});
    }

    const init=req.headers['x-telegram-init-data']||req.headers['x-init-data'];
    const user=userFromInitData(init);
    if(!user)return send(res,401,{error:'unauthorized: открой приложение из Telegram'});

    const uid=String(user.id);

    if(req.method==='GET' && url.pathname==='/api/balance')
      return send(res,200,{balance:db.balances[uid]||0});

    if(req.method==='POST' && url.pathname==='/api/topup/create'){
      const amount=Math.floor(Number((await readBody(req)).amount));
      if(!(amount>=1&&amount<=10000))return send(res,400,{error:'bad amount'});
      const r=await tgApi('createInvoiceLink',{
        title:'Пополнение баланса',description:`${amount} звёзд на баланс`,
        payload:`topup:${uid}:${Date.now()}`,currency:'XTR',prices:[{label:'Звёзды',amount}]
      });
      if(!r.ok)console.error('createInvoiceLink failed:',r);
      return r.ok?send(res,200,{link:r.result}):send(res,502,{error:'Telegram: '+r.description});
    }

    if(url.pathname==='/api/admin/cases' && (req.method==='PUT' || req.method==='POST')){
      if(!adminOk(req,user))return send(res,403,{error:'admin access denied'});
      const body=await readBody(req);
      const cases=normalizeCases(body.cases);
      db.cases=cases;
      db.version=Number(db.version||0)+1;
      save();
      return send(res,200,{ok:true,data:{version:db.version,cases:db.cases.map(publicCase)}});
    }

    return send(res,404,{error:'not found'});
  }catch(e){
    console.error(e);
    return send(res,500,{error:'server error'});
  }
}).listen(process.env.PORT||3000,()=>console.log(`Server listening on ${process.env.PORT||3000}`));
