import zlib,struct,sys
def chunk(t,b): return struct.pack('>I',len(b))+t+b+struct.pack('>I',zlib.crc32(t+b))
src,dst=sys.argv[1:3]
d=open(src,'rb').read();p=8;idat=b''
while p<len(d):
    n,=struct.unpack('>I',d[p:p+4]);t=d[p+4:p+8]
    if t==b'IDAT':idat+=d[p+8:p+8+n]
    if t==b'IHDR':w,h,bd,ct=struct.unpack('>IIBB',d[p+8:p+18])
    p+=12+n
assert (bd,ct)==(8,6)
r=zlib.decompress(idat);out=b''
for y in range(h):
    row=r[y*(w*4+1)+1:(y+1)*(w*4+1)];assert r[y*(w*4+1)]==0
    out+=b'\0'+b''.join(bytes((128,128,128,row[i+3])) for i in range(0,w*4,4))
open(dst,'wb').write(b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',w,h,8,6,0,0,0))+chunk(b'IDAT',zlib.compress(out,9))+chunk(b'IEND',b''))
