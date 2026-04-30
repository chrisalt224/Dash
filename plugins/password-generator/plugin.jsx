// Password Generator — Cryptographically random passwords + passphrases.
//
// • Two modes: password (length-based, char-class toggles) and passphrase
//   (xkcd-style, 4 random words + optional digits).
// • All randomness from window.crypto.getRandomValues — no Math.random.
// • Big readable output, click anywhere on it to copy.
// • Tiny strength indicator: log2(pool^len) for passwords, log2(words^n)
//   for passphrases. Color: red < 60, amber < 90, green ≥ 90.

const KEY = 'plugin:password-generator:state:v1';

const CHARS = {
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  lower: 'abcdefghijklmnopqrstuvwxyz',
  digits: '0123456789',
  symbols: '!@#$%^&*()-_=+[]{};:,.<>?/~',
};
const AMBIGUOUS = /[il1IO0o]/g;

// Curated short-word list — readable, ASCII, all 4-7 letters.
const WORDS = (
  'apple,beach,blank,brave,brisk,bronze,brown,brush,canvas,castle,cedar,chalk,charm,cherry,chord,cloud,coast,coral,coven,cream,crisp,crowd,crown,crust,daily,dance,dawn,daze,delta,depth,diary,direct,dock,dome,dose,doubt,dove,drift,drink,drove,dry,duel,dusk,dust,eagle,early,earth,easel,echo,edge,elder,elite,elm,ember,empty,enter,equal,event,exit,extra,fable,faint,fairy,faith,fancy,farm,fault,feast,feed,fence,fern,ferry,field,fifth,final,finch,first,fish,flag,flame,flash,flask,fleet,flesh,flint,float,flock,flood,floor,flour,flow,flute,foam,focus,foggy,folk,force,forge,forty,frame,fresh,frog,front,frost,fruit,fuel,full,funny,fury,fuse,gaze,gentle,giant,giddy,gift,glass,glide,gloss,glove,glow,gold,golf,grace,grain,grand,grape,grass,gray,green,grim,grip,grove,group,guide,gulf,habit,hand,happy,harbor,hare,harm,harp,hart,haste,hatch,haunt,haven,hazel,hazy,heart,heath,heavy,hedge,herb,herd,hero,hide,high,hint,hive,hold,hole,holly,home,honey,hood,hook,hope,horn,horse,hose,host,hotel,house,hover,human,humor,hunt,hurry,husk,ice,icy,idea,ideal,idle,ignite,igloo,image,index,indigo,ink,inn,iris,iron,ivory,ivy,jade,jazz,jelly,jewel,joke,joy,judge,juice,jumbo,jump,junior,junk,jury,karma,kayak,keen,keep,kettle,key,khaki,kick,kind,king,kiss,kite,kitten,knife,knight,knot,know,koala,label,labor,lace,lack,lake,lamb,land,lane,large,laser,last,latch,latte,lava,lawn,layer,lazy,lead,leaf,lean,leap,learn,least,leave,ledge,left,legal,lemon,lens,level,light,lily,lime,linen,lion,liquid,list,liver,lizard,llama,load,local,lock,lodge,loft,logic,lone,long,loose,lord,loss,lost,lotus,loud,lounge,love,lover,lucky,lunar,lunch,lung,lush,lute,lyric,maple,marble,march,mark,marsh,mason,mast,match,math,maze,meadow,meal,meat,medal,medic,meet,melon,memo,merit,merry,mesh,metal,meter,midi,might,milk,mill,mind,mint,mirror,miss,mist,model,moist,mole,money,month,mood,moon,moose,moral,more,morning,mossy,motel,moth,motor,mount,mouse,mouth,move,muddy,muffin,mug,mule,music,mute,myth,name,nasal,navy,near,neat,need,nephew,nest,never,newer,next,nibble,nice,niche,niece,night,noble,noise,none,noon,north,nose,note,novel,number,nurse,oak,oasis,oat,ocean,octave,offer,often,oil,old,olive,omen,onion,only,opal,open,opera,opium,orange,orbit,order,organ,osmosis,other,otter,ounce,outer,oval,oven,over,own,oxide,oyster,pack,page,paint,pair,palm,panda,panel,paper,parade,park,party,pass,past,patch,path,patio,pause,pawn,peach,peak,pear,pearl,pebble,peer,penny,perch,perfume,perk,pet,phone,piano,pick,picnic,pier,pig,pill,pillow,pilot,pine,pinky,pint,pipe,pirate,pitch,pity,pixel,place,plain,plan,plane,plant,plate,plaza,please,plot,plug,plum,plus,pocket,poem,poet,point,polar,pole,pond,pony,pool,pop,porch,pose,potato,pound,power,price,pride,prime,print,prize,profit,proof,proper,proud,prune,public,pulse,pump,puppy,purple,puzzle,quad,quail,quake,quart,queen,query,quest,quick,quiet,quill,quilt,quirky,quote,rabbit,radar,radio,raft,rage,rail,rain,raise,rake,ramp,ranch,range,rapid,rare,rash,raven,react,read,real,rebel,recap,recipe,red,reed,refit,relax,relic,renew,rent,reply,reset,rest,reveal,review,rhino,rib,rice,rich,ride,ridge,rifle,right,rigid,ring,rink,riot,rip,ripe,rise,risk,river,road,roast,rob,robot,rock,rocket,rocky,rod,role,roof,rookie,room,root,rope,rose,roster,rough,round,route,royal,rude,rug,ruin,rule,rumor,run,rural,sable,sack,sad,saddle,safe,sage,sail,salad,salmon,salt,same,sand,sash,sauce,save,scale,scan,scar,scarf,scene,scent,scion,score,scout,scrap,scrub,sea,seal,sear,seed,seek,sell,senior,sense,serial,serve,setup,shade,shake,shame,shape,share,shark,sharp,shed,sheep,sheet,shelf,shell,shield,shine,ship,shirt,shoe,shop,short,show,shrub,shy,sick,side,sigh,sign,silk,silly,silver,simple,sing,sip,sir,site,size,skate,skid,skin,skip,skull,sky,slab,slang,slate,sled,sleek,sleep,slice,slide,slim,slip,slot,slow,small,smart,smell,smile,smoke,snack,snail,snake,snap,snow,soap,sober,soft,soil,solar,solid,solo,solve,song,soon,sort,soul,sound,soup,sour,space,spade,span,spare,spark,speak,spend,spice,spike,spine,spire,split,spoil,spoon,sport,spot,spray,sprig,spring,spruce,spy,stable,stack,staff,stage,stain,stair,stake,stamp,stand,star,stare,start,stash,state,stay,steam,steel,steep,steer,stem,step,stew,stick,still,sting,stir,stock,stomp,stone,stop,store,storm,story,stout,stove,strap,straw,stress,strike,strip,strong,study,stuff,style,sub,subway,sugar,suit,sulfur,summit,sunny,super,sure,surf,survey,swap,sweet,swift,swim,swing,swirl,sword,table,tack,tag,tail,take,tale,tall,talon,tame,tank,tart,task,taste,tax,taxi,teach,team,tear,tech,teen,tell,temple,ten,tenor,tent,term,test,thank,thaw,thick,thin,thing,think,third,thirty,thorn,three,thrill,throb,throne,throw,thumb,tide,tidy,tiger,tight,tile,timber,time,tin,tint,tiny,tip,tired,title,toast,today,toe,token,tone,tonic,tooth,top,topic,torch,torso,toss,total,touch,tough,tour,tower,town,toxic,toy,trace,track,trade,trail,train,trait,tramp,trap,travel,tray,tread,treat,tree,trek,trend,tribe,trick,trim,trip,trout,truce,truck,true,trump,trunk,trust,truth,try,tube,tuck,tuna,tundra,tunnel,turkey,turn,turtle,tutor,twelve,twin,twist,type,uncle,under,undo,unify,union,unique,unit,unity,upon,upper,urban,used,user,usher,utter,vacant,vague,vain,valet,valid,valley,value,van,vase,vast,veil,velvet,vendor,verb,verge,verse,vertex,very,vest,veto,via,vibe,video,view,vigor,villa,vine,vinyl,viola,viper,viral,virtue,visa,visit,vista,vital,vivid,vocal,voice,void,volt,volume,vote,vow,voyage,wade,wafer,wage,wagon,wait,waiter,wake,walk,wall,wand,want,war,warm,warn,warp,wash,water,wave,wax,way,weak,wear,web,wedge,week,weigh,weird,welt,west,whale,wharf,wheat,wheel,when,where,which,whip,whirl,white,who,why,wide,wife,wig,wild,wind,wine,wing,wink,winter,wipe,wire,wisdom,wise,wish,wit,witch,with,wizard,wolf,wood,wool,word,work,world,worm,worry,worth,wound,woven,wrap,wreck,wrist,write,wrong,yacht,yam,yard,yarn,year,yeast,yellow,yes,yet,yield,yoga,young,zebra,zen,zero,zest,zinc,zone,zoo'
).split(',');

const DEFAULTS = {
  mode: 'password',
  length: 20,
  upper: true, lower: true, digits: true, symbols: true,
  noAmbiguous: false,
  wordCount: 4,
  separator: '-',
  capitalize: false,
  appendDigits: true,
};

const loadState = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (raw && typeof raw === 'object') return { ...DEFAULTS, ...raw };
  } catch {}
  return { ...DEFAULTS };
};

const randInt = (max) => crypto.getRandomValues(new Uint32Array(1))[0] % max;

const generate = (s) => {
  if (s.mode === 'passphrase') {
    const out = [];
    for (let i = 0; i < s.wordCount; i++) {
      let w = WORDS[randInt(WORDS.length)];
      if (s.capitalize) w = w[0].toUpperCase() + w.slice(1);
      out.push(w);
    }
    let result = out.join(s.separator);
    if (s.appendDigits) {
      const d = String(randInt(10000)).padStart(4, '0');
      result += s.separator + d;
    }
    return result;
  }
  let pool = '';
  if (s.upper) pool += CHARS.upper;
  if (s.lower) pool += CHARS.lower;
  if (s.digits) pool += CHARS.digits;
  if (s.symbols) pool += CHARS.symbols;
  if (s.noAmbiguous) pool = pool.replace(AMBIGUOUS, '');
  if (!pool) return '';
  const len = s.length;
  // Use Uint32 buffer & rejection sampling to avoid modulo bias for large pools
  const buf = new Uint32Array(len * 2);
  crypto.getRandomValues(buf);
  let result = '';
  let i = 0;
  while (result.length < len && i < buf.length) {
    const v = buf[i++];
    // Reject values that would bias the modulus — use largest multiple of pool.length under 2^32
    const limit = Math.floor(0xffffffff / pool.length) * pool.length;
    if (v < limit) result += pool[v % pool.length];
    if (i === buf.length && result.length < len) {
      crypto.getRandomValues(buf);
      i = 0;
    }
  }
  return result;
};

const computeStrength = (s) => {
  if (s.mode === 'passphrase') {
    const bits = Math.log2(WORDS.length) * s.wordCount + (s.appendDigits ? Math.log2(10000) : 0);
    return Math.round(bits);
  }
  let pool = 0;
  if (s.upper) pool += 26;
  if (s.lower) pool += 26;
  if (s.digits) pool += 10;
  if (s.symbols) pool += CHARS.symbols.length;
  if (s.noAmbiguous) pool = Math.max(0, pool - 6);
  if (!pool) return 0;
  return Math.round(Math.log2(pool) * s.length);
};

const strengthColor = (bits) => {
  if (bits < 60) return 'var(--danger)';
  if (bits < 90) return 'var(--accent-warm)';
  return 'var(--accent)';
};

export default {
  id: 'password-generator',
  name: 'Password',
  width: 2,
  height: 2,
  component: ({ useState, useEffect }) => {
    const [state, setState] = useState(loadState);
    const [output, setOutput] = useState('');
    const [toast, setToast] = useState(null);

    useEffect(() => { localStorage.setItem(KEY, JSON.stringify(state)); }, [state]);
    useEffect(() => { setOutput(generate(state)); }, [
      state.mode, state.length, state.upper, state.lower, state.digits,
      state.symbols, state.noAmbiguous, state.wordCount, state.separator,
      state.capitalize, state.appendDigits,
    ]);

    const regen = () => setOutput(generate(state));

    const copy = async () => {
      if (!output) return;
      try {
        const api = window.dashboard && window.dashboard.clipboard;
        if (api && api.write) await api.write(output);
        else if (navigator.clipboard) await navigator.clipboard.writeText(output);
        setToast('copied');
        setTimeout(() => setToast(null), 1200);
      } catch {
        setToast('copy failed');
        setTimeout(() => setToast(null), 1500);
      }
    };

    const bits = computeStrength(state);
    const sColor = strengthColor(bits);

    const Toggle = ({ k, label }) => (
      <button
        onClick={() => setState((s) => ({ ...s, [k]: !s[k] }))}
        style={{
          background: state[k] ? 'rgba(var(--accent-rgb),0.1)' : 'transparent',
          border: '1px solid ' + (state[k] ? 'var(--accent)' : 'var(--border-bright)'),
          color: state[k] ? 'var(--accent)' : 'var(--fg-dim)',
          fontFamily: 'var(--mono)',
          fontSize: 10,
          padding: '2px 6px',
          borderRadius: 2,
          cursor: 'pointer',
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
        }}
      >{label}</button>
    );

    return (
      <div className="p-col" style={{ height: '100%', gap: 6 }}>
        {/* Mode toggle */}
        <div className="p-row" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{
            display: 'inline-flex',
            border: '1px solid var(--border-bright)',
            borderRadius: 4, overflow: 'hidden',
          }}>
            {[{ id: 'password', label: 'password' }, { id: 'passphrase', label: 'passphrase' }].map((t) => {
              const active = state.mode === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => setState((s) => ({ ...s, mode: t.id }))}
                  style={{
                    background: active ? 'var(--accent)' : 'transparent',
                    color: active ? 'var(--bg)' : 'var(--fg-dim)',
                    border: 'none',
                    padding: '3px 10px',
                    fontFamily: 'var(--mono)',
                    fontSize: 10,
                    letterSpacing: '0.12em',
                    textTransform: 'uppercase',
                    fontWeight: active ? 700 : 400,
                    cursor: 'pointer',
                  }}
                >{t.label}</button>
              );
            })}
          </div>
          <span style={{
            fontFamily: 'var(--mono)', fontSize: 10,
            color: sColor,
            textShadow: '0 0 4px ' + sColor,
          }} title={'entropy estimate (log2 of search space)'}>{bits} bits</span>
        </div>

        {/* Output */}
        <div
          onClick={copy}
          title="click to copy"
          style={{
            cursor: 'pointer',
            fontFamily: 'var(--mono)',
            fontSize: state.mode === 'passphrase' ? 13 : 14,
            color: 'var(--fg-bright)',
            textShadow: '0 0 6px var(--accent)',
            background: 'rgba(0,0,0,0.3)',
            border: '1px solid var(--border-bright)',
            borderRadius: 3,
            padding: '8px 10px',
            wordBreak: 'break-all',
            lineHeight: 1.3,
            minHeight: 38,
            display: 'flex',
            alignItems: 'center',
          }}
        >{output || '(no charset selected)'}</div>

        {/* Settings (mode-specific) */}
        {state.mode === 'password' ? (
          <div className="p-col" style={{ gap: 4 }}>
            <div className="p-row" style={{ gap: 6, alignItems: 'center' }}>
              <span className="p-dim" style={{ fontSize: 10, width: 36 }}>len {state.length}</span>
              <input
                type="range" min="6" max="64" step="1"
                value={state.length}
                onChange={(e) => setState((s) => ({ ...s, length: parseInt(e.target.value, 10) }))}
                style={{ flex: 1, accentColor: 'var(--accent)' }}
              />
            </div>
            <div className="p-row" style={{ gap: 4, flexWrap: 'wrap' }}>
              <Toggle k="upper" label="A-Z" />
              <Toggle k="lower" label="a-z" />
              <Toggle k="digits" label="0-9" />
              <Toggle k="symbols" label="!@#" />
              <Toggle k="noAmbiguous" label="no ilO0" />
            </div>
          </div>
        ) : (
          <div className="p-col" style={{ gap: 4 }}>
            <div className="p-row" style={{ gap: 6, alignItems: 'center' }}>
              <span className="p-dim" style={{ fontSize: 10, width: 36 }}>words {state.wordCount}</span>
              <input
                type="range" min="3" max="8" step="1"
                value={state.wordCount}
                onChange={(e) => setState((s) => ({ ...s, wordCount: parseInt(e.target.value, 10) }))}
                style={{ flex: 1, accentColor: 'var(--accent)' }}
              />
              <span className="p-dim" style={{ fontSize: 10 }}>sep</span>
              <input
                value={state.separator}
                onChange={(e) => setState((s) => ({ ...s, separator: e.target.value.slice(0, 3) || '-' }))}
                maxLength={3}
                className="p-input"
                style={{ width: 32, fontSize: 11, textAlign: 'center', padding: '2px 4px' }}
              />
            </div>
            <div className="p-row" style={{ gap: 4 }}>
              <Toggle k="capitalize" label="Capitalize" />
              <Toggle k="appendDigits" label="+digits" />
            </div>
          </div>
        )}

        {/* Action row */}
        <div className="p-row" style={{ gap: 4 }}>
          <button className="p-btn" onClick={regen} style={{ flex: 1, padding: '4px 8px' }}>↻ regenerate</button>
          <button className="p-btn" onClick={copy} style={{ flex: 1, padding: '4px 8px' }}>
            {toast || 'copy'}
          </button>
        </div>
      </div>
    );
  },
};
